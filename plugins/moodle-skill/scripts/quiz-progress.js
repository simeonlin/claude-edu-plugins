/**
 * quiz-progress.js
 *
 * Scrapes live student quiz progress and submitted responses (including in-progress attempts)
 * across Moodle quizzes and generates an interactive live dashboard.
 */

import { JSDOM } from 'jsdom';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Main entry point for quiz-progress.
 *
 * @param {object} params
 * @param {number[]} [params.cmids] - Array of quiz course module IDs
 * @param {string|number} [params.sectionNum] - Section number to fetch all quizzes from
 * @param {boolean} [params.includeCode=true] - Whether to scrape full student code/responses
 * @param {string} [params.xmlDir] - Path to directory with question XML files for sample solutions
 * @param {string} [params.htmlOutput] - Output path for interactive HTML dashboard
 * @param {string} [params.jsonOutput] - Output path for raw JSON export
 * @param {object} moodle - Helper functions (moodleFetch, getCourseState, MOODLE_URL)
 */
export async function cmdQuizProgress(params, moodle) {
  let cmids = params.cmids || [];

  // Auto-discover cmids from section if provided
  let courseState = null;
  const quizTitles = {};
  try {
    courseState = await moodle.getCourseState();
    if (courseState?.cm) {
      for (const c of courseState.cm) {
        if (c.name) quizTitles[c.id] = c.name;
      }
    }
  } catch {
    // ignore
  }

  if ((!cmids || cmids.length === 0) && params.sectionNum !== undefined) {
    console.log(`Ermittle Quizzes aus Section ${params.sectionNum}...`);
    if (!courseState) courseState = await moodle.getCourseState();
    const section = courseState.section?.find(s => String(s.number) === String(params.sectionNum));
    if (!section) {
      throw new Error(`Section ${params.sectionNum} im Kurs nicht gefunden.`);
    }

    const quizModules = (section.cmlist || [])
      .map(id => courseState.cm?.find(c => c.id === id))
      .filter(c => c && (c.modname === 'quiz' || (c.name || '').toLowerCase().includes('quiz')));

    cmids = quizModules.map(c => c.id);
    console.log(`Gefundene Quizzes in Section ${params.sectionNum}: ${cmids.length} (${cmids.join(', ')})`);
  }

  if (cmids.length === 0) {
    throw new Error('Keine Quizzes angegeben. Bitte --cmids <id1,id2,...> oder --section <num> angeben.');
  }

  const includeCode = params.includeCode !== false;
  const sampleSolutions = loadSampleSolutionsFromXml(params.xmlDir);

  console.log(`\n=== Quiz-Fortschritt abrufen (${cmids.length} Quizzes) ===`);
  console.log(`Moodle URL: ${moodle.MOODLE_URL}`);
  console.log(`Code-Extraktion: ${includeCode ? 'Aktiviert' : 'Deaktiviert'}`);
  console.log('');

  const quizzesData = [];

  for (const cmid of cmids) {
    console.log(`Lade Uebersicht fuer Quiz cmid=${cmid}...`);
    const quizTitleHint = quizTitles[cmid];
    const quizData = await fetchQuizOverview(cmid, moodle, quizTitleHint);
    console.log(`  "${quizData.title}": ${quizData.attempts.length} Teilnehmer / Versuche`);

    if (includeCode && quizData.attempts.length > 0) {
      for (const attempt of quizData.attempts) {
        if (!attempt.attemptId) continue;
        console.log(`    Lade Antworten: ${attempt.studentName} (${attempt.state})...`);
        attempt.questions = await fetchAttemptDetails(attempt.attemptId, moodle, sampleSolutions, quizData.title);
        
        // Calculate current progress
        const essayQuestions = attempt.questions.filter(q => !q.isTheory);
        const answeredCount = essayQuestions.filter(q => q.hasCode).length;
        const inProgressQ = essayQuestions.find(q => !q.hasCode);
        
        attempt.currentStation = inProgressQ ? inProgressQ.qNum : (answeredCount > 0 ? 'Abgeschlossen' : 'Frage 1');
        attempt.answeredCount = answeredCount;
        attempt.totalQuestions = essayQuestions.length;
      }
    }

    quizzesData.push(quizData);
  }

  // Export JSON if requested
  if (params.jsonOutput) {
    writeFileSync(params.jsonOutput, JSON.stringify(quizzesData, null, 2));
    console.log(`\nJSON-Export gespeichert: ${params.jsonOutput}`);
  }

  // Generate HTML Dashboard
  const htmlPath = params.htmlOutput || './quiz-dashboard.html';
  const html = generateDashboardHtml(quizzesData, {
    moodleUrl: moodle.MOODLE_URL,
    generatedAt: new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })
  });
  writeFileSync(htmlPath, html);
  console.log(`HTML-Dashboard generiert: ${htmlPath}`);

  return quizzesData;
}

/**
 * Fetch overview table for a quiz.
 */
async function fetchQuizOverview(cmid, moodle, titleHint = null) {
  const url = `${moodle.MOODLE_URL}/mod/quiz/report.php?id=${cmid}&mode=overview`;
  const resp = await moodle.moodleFetch(url);
  const html = await resp.text();

  if (html.includes('login/index.php')) {
    throw new Error('Moodle-Session abgelaufen. Bitte MoodleSession im .env aktualisieren.');
  }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let title = titleHint;
  if (!title) {
    const titleEl = doc.querySelector('.page-header-headings h1, h2');
    title = titleEl ? titleEl.textContent.trim() : `Quiz ${cmid}`;
    if (title.toLowerCase() === 'blöcke' || title.toLowerCase() === 'blocks' || title.toLowerCase() === 'bewertung') {
      const breadcrumb = doc.querySelector('.breadcrumb');
      if (breadcrumb) {
        const items = [...breadcrumb.querySelectorAll('li')];
        title = items[items.length - 1]?.textContent?.trim() || `Quiz ${cmid}`;
      }
    }
  }

  const table = doc.querySelector('table#attempts');
  if (!table) {
    return { cmid, title, attempts: [], hasAttempts: false };
  }

  const rows = [...table.querySelectorAll('tbody tr')];
  const attempts = [];

  for (const row of rows) {
    const studentLink = row.querySelector('td.c2 a[href*="user/view.php"]');
    if (!studentLink) continue;

    const studentName = studentLink.textContent.trim();
    const studentEmail = row.querySelector('td.c3')?.textContent?.trim() || '';
    const state = row.querySelector('td.c10')?.textContent?.trim() || '';
    const startedAt = row.querySelector('td.c11')?.textContent?.trim() || '';
    const completedAt = row.querySelector('td.c12')?.textContent?.trim() || '';
    const duration = row.querySelector('td.c13')?.textContent?.trim() || '';
    const grade = row.querySelector('td.c14')?.textContent?.trim() || '';

    const reviewLink = row.querySelector('a[href*="review.php"]');
    const attemptIdMatch = reviewLink?.getAttribute('href')?.match(/attempt=(\d+)/);
    const attemptId = attemptIdMatch ? parseInt(attemptIdMatch[1]) : null;

    // Slot states from table columns
    const slotColumns = [...row.querySelectorAll('td[class*="c"]')].slice(15);
    const slotSummaries = slotColumns.map((col, idx) => {
      const slotMatch = col.querySelector('a')?.getAttribute('href')?.match(/slot=(\d+)/);
      const isAnswerSaved = col.querySelector('.answersaved') !== null;
      const isNotAnswered = col.querySelector('.notyetanswered') !== null;
      const gradeText = col.textContent?.trim() || '';
      return {
        slot: slotMatch ? parseInt(slotMatch[1]) : idx + 1,
        status: isAnswerSaved ? 'saved' : (isNotAnswered ? 'not_answered' : 'other'),
        raw: gradeText
      };
    });

    attempts.push({
      studentName,
      studentEmail,
      state,
      startedAt,
      completedAt,
      duration,
      grade,
      attemptId,
      slotSummaries,
      questions: []
    });
  }

  return {
    cmid,
    title,
    hasAttempts: attempts.length > 0,
    attempts
  };
}

/**
 * Fetch detailed student responses and questions for an attempt.
 */
async function fetchAttemptDetails(attemptId, moodle, sampleSolutions = {}, quizTitle = '') {
  const url = `${moodle.MOODLE_URL}/mod/quiz/review.php?attempt=${attemptId}`;
  const resp = await moodle.moodleFetch(url);
  const html = await resp.text();

  if (html.includes('login/index.php')) {
    throw new Error('Moodle-Session abgelaufen. Bitte MoodleSession im .env aktualisieren.');
  }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const questions = [];
  const questionDivs = [...doc.querySelectorAll('.que')];

  let currentTheory = null;
  let essayIndex = 0;

  // Extract quiz number from quizTitle, e.g. "Quiz 1" -> 1
  const quizNumMatch = quizTitle.match(/Quiz\s*(\d+)/i);
  const quizNum = quizNumMatch ? quizNumMatch[1] : '';

  for (const qDiv of questionDivs) {
    const noText = qDiv.querySelector('.info .no')?.textContent?.trim() || '';
    const isTheory = noText.toLowerCase().includes('information') || qDiv.className.includes('description');
    
    const titleEl = qDiv.querySelector('.content .qtext h3, .content .qtext h4, .content .qtext p strong');
    const qTitle = titleEl ? titleEl.textContent.trim() : noText;

    if (isTheory) {
      currentTheory = qTitle;
      continue;
    }

    const state = qDiv.querySelector('.info .state')?.textContent?.trim() || '';
    const grade = qDiv.querySelector('.info .grade')?.textContent?.trim() || '';

    // Extract student's code response
    const textarea = qDiv.querySelector('.content .answer textarea, textarea.qtype_essay_response');
    let code = textarea ? textarea.value : '';
    if (!code) {
      const respEl = qDiv.querySelector('.qtype_essay_response, .content .answer');
      code = respEl ? respEl.textContent?.trim() : '';
      code = code.replace(/^Antworttext\s+Frage\s+\d+\s*/i, '');
    }
    code = (code || '').trim();

    // Match with sample solution by index or title
    let sampleSolution = '';
    const indexedKey = `${quizNum}_${essayIndex}`;
    if (sampleSolutions[indexedKey]) {
      sampleSolution = sampleSolutions[indexedKey].solution;
    } else {
      for (const [key, sol] of Object.entries(sampleSolutions)) {
        if (qTitle.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(qTitle.toLowerCase())) {
          sampleSolution = sol.solution;
          break;
        }
      }
    }

    questions.push({
      qNum: noText,
      theorySection: currentTheory,
      title: qTitle,
      state,
      grade,
      hasCode: code.length > 0,
      codeLength: code.length,
      code,
      sampleSolution
    });

    essayIndex++;
  }

  return questions;
}

/**
 * Load sample solutions from XML files in the specified or course directory.
 */
function loadSampleSolutionsFromXml(xmlDir) {
  const solutions = {};
  const searchDirs = [
    xmlDir,
    resolve(process.cwd(), './04-flutter-einstieg-dart-programming'),
    resolve(process.cwd())
  ].filter(d => d && existsSync(d));

  for (const dir of searchDirs) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.xml'));
      for (const file of files) {
        const content = readFileSync(join(dir, file), 'utf-8');
        
        // Find category quiz number, e.g. "Quiz 1", "Quiz 2"
        const catMatch = content.match(/<category>[\s\S]*?<text>(.*?)<\/text>/);
        const catText = catMatch ? catMatch[1] : file;
        const qNumMatch = catText.match(/Quiz\s*(\d+)/i) || file.match(/quiz-(\d+)/i);
        const quizNum = qNumMatch ? qNumMatch[1] : '';

        // Match <question type="essay"> ... </question>
        const essayBlocks = content.match(/<question\s+type="essay"[\s\S]*?<\/question>/g) || [];
        essayBlocks.forEach((block, idx) => {
          const nameMatch = block.match(/<name>[\s\S]*?<text>(.*?)<\/text>[\s\S]*?<\/name>/);
          const feedbackMatch = block.match(/<generalfeedback[^>]*>[\s\S]*?<text><!\[CDATA\[([\s\S]*?)\]\]><\/text>/);
          if (nameMatch && feedbackMatch) {
            const name = nameMatch[1].trim();
            let feedback = feedbackMatch[1].trim();
            // Extract code snippet if present in <pre><code>
            const codeMatch = feedback.match(/<code[^>]*>([\s\S]*?)<\/code>/);
            const solutionCode = codeMatch ? codeMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : feedback;
            
            const item = { title: name, solution: solutionCode };
            solutions[name] = item;
            if (quizNum) {
              solutions[`${quizNum}_${idx}`] = item;
            }
          }
        });
      }
    } catch {
      // ignore
    }
  }

  return solutions;
}

/**
 * Generate standalone responsive interactive HTML dashboard.
 */
function generateDashboardHtml(quizzesData, meta) {
  const jsonData = JSON.stringify(quizzesData);

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lern-Quizzes Live-Fortschritt</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --success: #22c55e;
      --success-bg: rgba(34, 197, 94, 0.15);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.15);
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }

    .container { max-width: 1400px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
    }

    h1 { font-size: 24px; font-weight: 700; color: #fff; }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-top: 4px; }

    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
    }
    .stat-label { font-size: 13px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #fff; margin-top: 4px; }

    .controls {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }

    .search-input {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      min-width: 260px;
    }
    .search-input:focus { outline: none; border-color: var(--primary); }

    .tab-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 10px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .tab-btn:hover { color: #fff; border-color: #475569; }
    .tab-btn.active { background: var(--primary); color: #0f172a; border-color: var(--primary); font-weight: 600; }

    .quiz-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
    }

    .quiz-header {
      padding: 16px 20px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .quiz-title { font-size: 17px; font-weight: 600; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-success { background: var(--success-bg); color: var(--success); }
    .badge-warning { background: var(--warning-bg); color: var(--warning); }
    .badge-muted { background: rgba(148, 163, 184, 0.1); color: var(--text-muted); }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th, td {
      padding: 12px 18px;
      border-bottom: 1px solid var(--card-border);
      font-size: 14px;
    }
    th {
      background: rgba(15, 23, 42, 0.5);
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:hover { background: rgba(255, 255, 255, 0.02); }

    .student-cell {
      display: flex;
      flex-direction: column;
    }
    .student-name { font-weight: 600; color: #fff; }
    .student-email { font-size: 12px; color: var(--text-muted); }

    .station-cell {
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.15s ease;
      border-radius: 6px;
      user-select: none;
    }
    .station-cell:hover { background: rgba(56, 189, 248, 0.15); }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
    }
    .status-pill.submitted {
      background: var(--success-bg);
      color: var(--success);
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .status-pill.working {
      background: var(--warning-bg);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.4);
      animation: pulse 2s infinite;
    }
    .status-pill.empty {
      background: rgba(148, 163, 184, 0.08);
      color: var(--text-muted);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal-backdrop.open { display: flex; }

    .modal {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      width: 100%;
      max-width: 1000px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }

    .modal-header {
      padding: 18px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-title { font-size: 18px; font-weight: 600; color: #fff; }
    .modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
    }
    .modal-close:hover { color: #fff; }

    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      flex: 1;
    }

    .code-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 16px;
    }
    @media (max-width: 800px) {
      .code-grid { grid-template-columns: 1fr; }
    }

    .code-block {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .code-header {
      padding: 8px 14px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--card-border);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    pre {
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      overflow-x: auto;
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .copy-btn {
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .copy-btn:hover { background: rgba(255, 255, 255, 0.15); }
  </style>
</head>
<body>

  <div class="container">
    <header>
      <div>
        <h1>Lern-Quizzes Live-Fortschritt</h1>
        <div class="subtitle">Stand: ${meta.generatedAt} &bull; Moodle: ${meta.moodleUrl}</div>
      </div>
      <div>
        <button class="tab-btn active" onclick="location.reload()">Aktualisieren</button>
      </div>
    </header>

    <div class="stats-bar" id="statsBar"></div>

    <div class="controls">
      <input type="text" id="searchInput" class="search-input" placeholder="Student suchen..." oninput="render()">
      <div id="quizTabs" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
    </div>

    <div id="quizContainer"></div>
  </div>

  <!-- Modal Code Inspector -->
  <div class="modal-backdrop" id="codeModal" onclick="closeModal(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div>
          <div class="modal-title" id="modalStudentTitle">Student &bull; Frage</div>
          <div style="font-size:13px;color:var(--text-muted);margin-top:2px;" id="modalQuestionTitle"></div>
        </div>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="code-grid">
          <div class="code-block">
            <div class="code-header">
              <span>Abgabe des Studenten</span>
              <button class="copy-btn" onclick="copyStudentCode()">Kopieren</button>
            </div>
            <pre><code id="modalStudentCode"></code></pre>
          </div>
          <div class="code-block">
            <div class="code-header">
              <span>Musterlösung</span>
              <button class="copy-btn" onclick="copySolutionCode()">Kopieren</button>
            </div>
            <pre><code id="modalSolutionCode"></code></pre>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const data = ${jsonData};
    let activeQuizCmid = null; // null = all quizzes

    function init() {
      // Setup tabs
      const tabsEl = document.getElementById('quizTabs');
      let tabsHtml = '<button class="tab-btn active" onclick="setQuiz(null, this)">Alle Quizzes</button>';
      data.forEach(q => {
        tabsHtml += \`<button class="tab-btn" onclick="setQuiz(\${q.cmid}, this)">\${escapeHtml(q.title.replace(/^\\d+-Lern-Quiz\\s*\\d*:\\s*/, ''))}</button>\`;
      });
      tabsEl.innerHTML = tabsHtml;

      render();
    }

    function setQuiz(cmid, btn) {
      activeQuizCmid = cmid;
      document.querySelectorAll('#quizTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    }

    function render() {
      const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
      const container = document.getElementById('quizContainer');
      const statsBar = document.getElementById('statsBar');

      let totalStarted = 0;
      let totalCompleted = 0;
      let totalCodes = 0;

      data.forEach(q => {
        q.attempts.forEach(a => {
          if (a.attemptId) {
            totalStarted++;
            if (a.state.toLowerCase().includes('beendet')) totalCompleted++;
            if (a.questions) {
              totalCodes += a.questions.filter(quest => quest.hasCode).length;
            }
          }
        });
      });

      statsBar.innerHTML = \`
        <div class="stat-card">
          <div class="stat-label">Gestartete Versuche</div>
          <div class="stat-value">\${totalStarted}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Beendet</div>
          <div class="stat-value" style="color:var(--success)">\${totalCompleted}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">In Bearbeitung</div>
          <div class="stat-value" style="color:var(--warning)">\${totalStarted - totalCompleted}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Eingereichte Lösungen</div>
          <div class="stat-value" style="color:var(--primary)">\${totalCodes}</div>
        </div>
      \`;

      const visibleQuizzes = activeQuizCmid ? data.filter(q => q.cmid === activeQuizCmid) : data;

      let html = '';

      visibleQuizzes.forEach(quiz => {
        const filteredAttempts = quiz.attempts.filter(a => {
          if (!searchTerm) return a.attemptId !== null;
          return (a.studentName.toLowerCase().includes(searchTerm) || a.studentEmail.toLowerCase().includes(searchTerm)) && a.attemptId !== null;
        });

        // Determine essay question headers from the first attempt with questions
        const firstWithQ = quiz.attempts.find(a => a.questions && a.questions.length > 0);
        const essayHeaders = firstWithQ ? firstWithQ.questions.filter(q => !q.isTheory) : [];

        html += \`
          <div class="quiz-card">
            <div class="quiz-header">
              <div class="quiz-title">\${escapeHtml(quiz.title)}</div>
              <div>
                <span class="badge \${filteredAttempts.length > 0 ? 'badge-success' : 'badge-muted'}">
                  \${filteredAttempts.length} aktive/abgeschlossene Versuche
                </span>
              </div>
            </div>
        \`;

        if (filteredAttempts.length === 0) {
          html += '<div style="padding: 24px; color: var(--text-muted); text-align: center;">Noch keine Versuche von Studierenden abgegeben.</div>';
        } else {
          html += \`
            <table>
              <thead>
                <tr>
                  <th style="width: 250px;">Student</th>
                  <th style="width: 140px;">Status</th>
                  <th style="width: 130px;">Dauer</th>
                  \${essayHeaders.map(eh => \`<th>\${escapeHtml(eh.qNum)}</th>\`).join('')}
                </tr>
              </thead>
              <tbody>
          \`;

          filteredAttempts.forEach(attempt => {
            const isFinished = attempt.state.toLowerCase().includes('beendet');
            const statusClass = isFinished ? 'badge-success' : 'badge-warning';

            html += \`
              <tr>
                <td>
                  <div class="student-cell">
                    <span class="student-name">\${escapeHtml(attempt.studentName)}</span>
                    <span class="student-email">\${escapeHtml(attempt.studentEmail)}</span>
                  </div>
                </td>
                <td><span class="badge \${statusClass}">\${escapeHtml(attempt.state)}</span></td>
                <td>\${escapeHtml(attempt.duration || '-')}</td>
            \`;

            if (essayHeaders.length > 0 && attempt.questions) {
              const studentEssays = attempt.questions.filter(q => !q.isTheory);
              essayHeaders.forEach((eh, idx) => {
                const sq = studentEssays[idx];
                if (!sq) {
                  html += '<td><span class="status-pill empty">—</span></td>';
                  return;
                }

                if (sq.hasCode) {
                  html += \`
                    <td>
                      <div class="station-cell" onclick="openModal('\${escapeAttr(attempt.studentName)}', \${quiz.cmid}, \${idx})">
                        <span class="status-pill submitted">
                          ✓ \${sq.codeLength} Z.
                        </span>
                      </div>
                    </td>
                  \`;
                } else if (!isFinished && (!studentEssays[idx - 1] || studentEssays[idx - 1].hasCode)) {
                  // Current station
                  html += \`
                    <td>
                      <div class="station-cell" onclick="openModal('\${escapeAttr(attempt.studentName)}', \${quiz.cmid}, \${idx})">
                        <span class="status-pill working">
                          ✍️ In Arbeit
                        </span>
                      </div>
                    </td>
                  \`;
                } else {
                  html += '<td><span class="status-pill empty">—</span></td>';
                }
              });
            }

            html += '</tr>';
          });

          html += '</tbody></table>';
        }

        html += '</div>';
      });

      container.innerHTML = html;
    }

    let currentStudentCode = '';
    let currentSolutionCode = '';

    function openModal(studentName, cmid, questionIndex) {
      const quiz = data.find(q => q.cmid === cmid);
      if (!quiz) return;
      const attempt = quiz.attempts.find(a => a.studentName === studentName);
      if (!attempt || !attempt.questions) return;
      const essays = attempt.questions.filter(q => !q.isTheory);
      const q = essays[questionIndex];
      if (!q) return;

      currentStudentCode = q.code || '// Kein Code abgegeben';
      currentSolutionCode = q.sampleSolution || '// Keine Musterlösung hinterlegt';

      document.getElementById('modalStudentTitle').textContent = \`\${studentName} • \${q.qNum}\`;
      document.getElementById('modalQuestionTitle').textContent = q.title;
      document.getElementById('modalStudentCode').textContent = currentStudentCode;
      document.getElementById('modalSolutionCode').textContent = currentSolutionCode;

      document.getElementById('codeModal').classList.add('open');
    }

    function closeModal() {
      document.getElementById('codeModal').classList.remove('open');
    }

    function copyStudentCode() {
      navigator.clipboard.writeText(currentStudentCode);
    }

    function copySolutionCode() {
      navigator.clipboard.writeText(currentSolutionCode);
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeAttr(str) {
      return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    init();
  </script>
</body>
</html>
`;
}
