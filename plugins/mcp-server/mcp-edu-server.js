#!/usr/bin/env node

/**
 * MCP server for Claude Edu Plugins.
 *
 * Wraps all Moodle and Kahoot CLI commands as structured MCP tools so any
 * MCP-compatible agent (Claude Code, Copilot, Codex, Cursor, Windsurf,
 * Gemini CLI, etc.) can call them directly.
 *
 * Usage:
 *   node mcp-edu-server.js
 *
 * The server communicates over stdio (stdin/stdout) using the MCP protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOODLE_SCRIPT = resolve(__dirname, "../moodle-skill/scripts/moodle-updater.js");
const MOODLE_DOWNLOAD_SCRIPT = resolve(__dirname, "../moodle-skill/scripts/download-course.js");
const MOODLE_UPLOAD_PLAN_SCRIPT = resolve(__dirname, "../moodle-skill/scripts/upload-course.js");
const MOODLE_EXECUTE_UPLOAD_SCRIPT = resolve(__dirname, "../moodle-skill/scripts/execute-upload.js");
const KAHOOT_SCRIPT = resolve(__dirname, "../kahoot-skill/scripts/kahoot-creator.js");

// ---------------------------------------------------------------------------
// Helper: run a CLI script and return its output
// ---------------------------------------------------------------------------

function run(script, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile("node", [script, ...args], { encoding: "utf-8", timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve(`Error (exit ${err.code ?? "?"}): ${stderr || err.message}\n${stdout}`.trim());
      } else {
        resolve((stdout + (stderr ? `\n${stderr}` : "")).trim());
      }
    });
  });
}

function text(promise) {
  return promise.then((output) => ({
    content: [{ type: "text", text: output || "(no output)" }],
  }));
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "edu-plugins",
  version: "1.0.0",
});

// ===========================================================================
//  MOODLE TOOLS
// ===========================================================================

// --- Authentication ---

server.tool(
  "moodle_login",
  "Open browser to log in to Moodle and save session cookie to .env",
  { browser: z.enum(["msedge", "chrome"]).optional().describe("Browser to use for SSO login") },
  ({ browser }) => text(run(MOODLE_SCRIPT, ["login", ...(browser ? ["--browser", browser] : [])], 120_000))
);

// --- Read operations ---

server.tool(
  "moodle_structure",
  "Show the full Moodle course structure (sections and activities)",
  {},
  () => text(run(MOODLE_SCRIPT, ["structure"]))
);

server.tool(
  "moodle_list_activities",
  "List all activities in a Moodle section",
  { sectionId: z.string().describe("Section ID") },
  ({ sectionId }) => text(run(MOODLE_SCRIPT, ["list-activities", sectionId]))
);

server.tool(
  "moodle_show_label",
  "Show the content of a Moodle label",
  { cmid: z.string().describe("Course module ID of the label") },
  ({ cmid }) => text(run(MOODLE_SCRIPT, ["show-label", cmid]))
);

server.tool(
  "moodle_show_page",
  "Show the content of a Moodle page",
  { cmid: z.string().describe("Course module ID of the page") },
  ({ cmid }) => text(run(MOODLE_SCRIPT, ["show-page", cmid]))
);

server.tool(
  "moodle_get_quiz_by_name",
  "Find the cmid of a quiz based on its name in a section",
  {
    sectionNum: z.string().describe("Section number"),
    quizName: z.string().describe("Quiz name"),
  },
  ({ sectionNum, quizName }) => text(run(MOODLE_SCRIPT, ["get-quiz-by-name", sectionNum, quizName]))
);

// --- Update operations ---

server.tool(
  "moodle_update_label",
  "Update a Moodle label from a Markdown/HTML file (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID of the label"),
    contentFile: z.string().describe("Path to Markdown or HTML file with new content"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["update-label", cmid, contentFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_update_page",
  "Update a Moodle page from a Markdown/HTML file (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID of the page"),
    contentFile: z.string().describe("Path to Markdown or HTML file with new content"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["update-page", cmid, contentFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_update_summary",
  "Update a Moodle section summary from a Markdown/HTML file (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID"),
    contentFile: z.string().describe("Path to Markdown or HTML file with new summary"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["update-summary", sectionId, contentFile, ...(live ? ["--live"] : [])]))
);

// --- Create operations ---

server.tool(
  "moodle_create_label",
  "Create a new Moodle label (text section) from a Markdown/HTML file (dry-run unless live=true)",
  {
    sectionNum: z.string().describe("Section number"),
    contentFile: z.string().describe("Path to Markdown or HTML file"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["create-label", sectionNum, contentFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_create_url",
  "Create a URL activity in a Moodle section (dry-run unless live=true). By default the link opens in a new window (display=3).",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Display name"),
    url: z.string().describe("URL"),
    display: z.number().int().min(0).max(6).default(3).describe("How to open the URL: 0=Auto 1=Embed 2=Frame 3=NewWindow(default) 4=Download 5=Open 6=Popup"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, name, url, display, live }) =>
    text(run(MOODLE_SCRIPT, ["create-url", sectionNum, name, url, "--display", String(display), ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_create_page",
  "Create a new Moodle page from a Markdown/HTML file (dry-run unless live=true)",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Page name"),
    contentFile: z.string().describe("Path to Markdown or HTML file"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, name, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["create-page", sectionNum, name, contentFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_create_resource",
  "Upload a file resource to a Moodle section (dry-run unless live=true)",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Resource name"),
    filePath: z.string().describe("Path to the file to upload"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, name, filePath, live }) =>
    text(run(MOODLE_SCRIPT, ["create-resource", sectionNum, name, filePath, ...(live ? ["--live"] : [])], 180_000))
);

server.tool(
  "moodle_create_assign",
  "Create an assignment in Moodle (dry-run unless live=true). Defaults: text input + file submission enabled; open date, cutoff date, and grading due date disabled. Due date is disabled unless 'due' is provided.",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Assignment name"),
    contentFile: z.string().describe("Path to HTML file with assignment description"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
    due: z.string().optional().describe("Due date as Unix timestamp in seconds (e.g. 1747350000 for 2025-05-15 23:59 Europe/Zurich). Use Date.parse('...') / 1000 or a UTC epoch calculator. If omitted, due date is disabled."),
  },
  ({ sectionNum, name, contentFile, live, due }) =>
    text(run(MOODLE_SCRIPT, [
      "create-assign", sectionNum, name, contentFile,
      ...(live ? ["--live"] : []),
      ...(due ? ["--due", due] : []),
    ]))
);

server.tool(
  "moodle_create_forum",
  "Create a forum in Moodle (dry-run unless live=true)",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Forum name"),
    contentFile: z.string().describe("Path to HTML file with forum intro"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, name, contentFile, live }) =>
    text(run(MOODLE_SCRIPT, ["create-forum", sectionNum, name, contentFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_create_quiz",
  "Create a quiz in Moodle (dry-run unless live=true). Open/close times and time limit are disabled unless explicitly provided.",
  {
    sectionNum: z.string().describe("Section number"),
    name: z.string().describe("Quiz name"),
    configFile: z.string().optional().describe("Path to quiz config JSON file (optional)"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
    timeopen: z.string().optional().describe("Quiz open time as Unix timestamp in seconds (e.g. 1747350000 for 2025-05-15 08:00 Europe/Zurich). If omitted, open time is disabled."),
    timeclose: z.string().optional().describe("Quiz close time as Unix timestamp in seconds. If omitted, close time is disabled."),
    timeLimit: z.number().int().optional().describe("Time limit per attempt in seconds (e.g. 3600 = 1 hour). If omitted, no time limit."),
  },
  async ({ sectionNum, name, configFile, live, timeopen, timeclose, timeLimit }) => {
    let config = { name };
    if (configFile) {
      const { readFileSync } = await import("fs");
      const fileConfig = JSON.parse(readFileSync(resolve(configFile), "utf-8"));
      config = { ...fileConfig, name }; // name from MCP parameter always wins
    }
    // Explicit MCP parameters override config file values
    if (timeopen !== undefined) config.timeopen = parseInt(timeopen, 10);
    if (timeclose !== undefined) config.timeclose = parseInt(timeclose, 10);
    if (timeLimit !== undefined) config.timeLimit = timeLimit;
    const { writeFileSync, unlinkSync } = await import("fs");
    const tmpPath = resolve(__dirname, `tmp-quiz-config-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(config));
    try {
      return await text(run(MOODLE_SCRIPT, ["create-quiz", sectionNum, tmpPath, ...(live ? ["--live"] : [])]));
    } finally {
      unlinkSync(tmpPath);
    }
  }
);

// --- Section operations ---

server.tool(
  "moodle_add_section",
  "Append a new empty section at the end of the Moodle course (dry-run unless live=true)",
  { live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)") },
  ({ live }) => text(run(MOODLE_SCRIPT, ["add-section", ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_duplicate_section",
  "Duplicate the last Moodle section (dry-run unless live=true)",
  { live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)") },
  ({ live }) => text(run(MOODLE_SCRIPT, ["duplicate-section", ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_rename_section",
  "Rename a Moodle section (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID"),
    name: z.string().describe("New section name"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, name, live }) =>
    text(run(MOODLE_SCRIPT, ["rename-section", sectionId, name, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_move_section",
  "Move a Moodle section before another section (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID to move"),
    targetSectionId: z.string().describe("Target section ID (move before this)"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, targetSectionId, live }) =>
    text(run(MOODLE_SCRIPT, ["move-section", sectionId, targetSectionId, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_delete_section",
  "Delete a Moodle section (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID to delete"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, live }) =>
    text(run(MOODLE_SCRIPT, ["delete-section", sectionId, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_show_section",
  "Show a Moodle section (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID to show"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, live }) =>
    text(run(MOODLE_SCRIPT, ["show-section", sectionId, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_hide_section",
  "Hide a Moodle section (dry-run unless live=true)",
  {
    sectionId: z.string().describe("Section ID to hide"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionId, live }) =>
    text(run(MOODLE_SCRIPT, ["hide-section", sectionId, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_clear_section",
  "Delete all activities in a section to create a clean state",
  {
    sectionNum: z.string().describe("Section number or ID to clear"),
    confirm: z.boolean().describe("Explicit confirmation to delete ALL contents and submissions in this section"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ sectionNum, confirm, live }) => {
    if (!confirm && live) {
      return Promise.resolve({
        content: [{ type: "text", text: "Error: You must explicitly confirm that all contents and submissions of the section should be deleted by setting 'confirm' to true." }],
        isError: true,
      });
    }
    return text(run(MOODLE_SCRIPT, ["clear-section", sectionNum, ...(live ? ["--live"] : [])]));
  }
);

// --- Activity operations ---

server.tool(
  "moodle_delete_activity",
  "Delete a Moodle activity (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, live }) =>
    text(run(MOODLE_SCRIPT, ["delete-activity", cmid, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_indent_activity",
  "Indent a Moodle activity (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, live }) =>
    text(run(MOODLE_SCRIPT, ["indent-activity", cmid, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_hide_activity",
  "Hide a Moodle activity (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, live }) =>
    text(run(MOODLE_SCRIPT, ["hide-activity", cmid, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_show_activity",
  "Show a Moodle activity (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, live }) =>
    text(run(MOODLE_SCRIPT, ["show-activity", cmid, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_move_activity",
  "Move a Moodle activity to a different section (dry-run unless live=true)",
  {
    cmid: z.string().describe("Course module ID to move"),
    targetSectionId: z.string().describe("Target section ID"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmid, targetSectionId, live }) =>
    text(run(MOODLE_SCRIPT, ["move-activity", cmid, targetSectionId, ...(live ? ["--live"] : [])]))
);

server.tool(
  "moodle_move_activity_after",
  "Move a Moodle activity behind another activity (dry-run unless live=true)",
  {
    cmidToMove: z.string().describe("Course module ID to move"),
    afterCmid: z.string().describe("Target course module ID (move after this)"),
    live: z.boolean().default(false).describe("Set true to apply changes (default: dry-run)"),
  },
  ({ cmidToMove, afterCmid, live }) =>
    text(run(MOODLE_SCRIPT, ["move-activity-after", cmidToMove, afterCmid, ...(live ? ["--live"] : [])]))
);

// --- Quiz operations ---

server.tool(
  "moodle_import_gift",
  "Import GIFT-format questions into a Moodle quiz",
  {
    cmid: z.string().describe("Course module ID of the quiz"),
    giftFile: z.string().describe("Path to GIFT file"),
  },
  ({ cmid, giftFile }) => text(run(MOODLE_SCRIPT, ["import-gift", cmid, giftFile], 120_000))
);

server.tool(
  "moodle_import_moodle_xml",
  "Import Moodle-XML-format questions into a Moodle quiz",
  {
    cmid: z.string().describe("Course module ID of the quiz"),
    xmlFile: z.string().describe("Path to Moodle XML file"),
  },
  ({ cmid, xmlFile }) => text(run(MOODLE_SCRIPT, ["import-moodle-xml", cmid, xmlFile], 120_000))
);

server.tool(
  "moodle_delete_quiz_questions",
  "Delete all questions from a Moodle quiz category",
  {
    cmid: z.string().describe("Course module ID of the quiz"),
    categoryName: z.string().optional().describe("Category name (default: quiz's default category)"),
  },
  ({ cmid, categoryName }) =>
    text(run(MOODLE_SCRIPT, ["delete-quiz-questions", cmid, ...(categoryName ? [categoryName] : [])]))
);

server.tool(
  "moodle_add_questions_to_quiz",
  "Add questions from a category to a Moodle quiz",
  {
    cmid: z.string().describe("Course module ID of the quiz"),
    categoryName: z.string().optional().describe("Category name"),
  },
  ({ cmid, categoryName }) =>
    text(run(MOODLE_SCRIPT, ["add-questions-to-quiz", cmid, ...(categoryName ? [categoryName] : [])]))
);

server.tool(
  "moodle_get_quiz_categories",
  "List all question categories available in the context of a quiz",
  { cmid: z.string().describe("Course module ID of the quiz") },
  ({ cmid }) => text(run(MOODLE_SCRIPT, ["get-quiz-categories", cmid]))
);

// --- AI Grading ---

server.tool(
  "moodle_grade_essay",
  "AI-assisted essay grading: scrape submissions, grade with AI, and submit grades",
  {
    cmid: z.string().describe("Course module ID of the assignment"),
    giftFile: z.string().optional().describe("Path to GIFT file with expected answers"),
    slot: z.string().optional().describe("Slot number to grade"),
    model: z.string().optional().describe("AI model name for grading"),
    report: z.string().optional().describe("Path to save grading report"),
    regrade: z.boolean().optional().describe("Re-grade already graded submissions"),
    live: z.boolean().default(false).describe("Set true to submit grades (default: dry-run)"),
  },
  ({ cmid, giftFile, slot, model, report, regrade, live }) =>
    text(run(MOODLE_SCRIPT, [
      "grade-essay", cmid,
      ...(giftFile ? ["--gift", giftFile] : []),
      ...(slot ? ["--slot", slot] : []),
      ...(model ? ["--model", model] : []),
      ...(report ? ["--report", report] : []),
      ...(regrade ? ["--regrade"] : []),
      ...(live ? ["--live"] : []),
    ], 300_000))
);

server.tool(
  "moodle_get_quiz_progress",
  "Track live student progress and code submissions across quizzes (including in-progress attempts), with optional interactive HTML dashboard",
  {
    cmids: z.array(z.string()).optional().describe("Array of quiz module IDs (cmids)"),
    sectionNum: z.string().optional().describe("Section number to auto-detect all quizzes from"),
    htmlOutput: z.string().optional().describe("Output path for HTML dashboard (default: ./quiz-dashboard.html)"),
    jsonOutput: z.string().optional().describe("Output path for JSON export"),
    xmlDir: z.string().optional().describe("Directory with XML question files for sample solutions"),
    includeCode: z.boolean().default(true).describe("Whether to scrape full student code (default: true)"),
  },
  ({ cmids, sectionNum, htmlOutput, jsonOutput, xmlDir, includeCode }) =>
    text(run(MOODLE_SCRIPT, [
      "quiz-progress",
      ...(cmids && cmids.length > 0 ? cmids : []),
      ...(sectionNum ? ["--section", sectionNum] : []),
      ...(htmlOutput ? ["--html", htmlOutput] : []),
      ...(jsonOutput ? ["--json", jsonOutput] : []),
      ...(xmlDir ? ["--xml", xmlDir] : []),
      ...(!includeCode ? ["--no-code"] : []),
    ], 300_000))
);

// --- Course round-trip (download / template / upload) ---

server.tool(
  "moodle_download_course",
  "Mirror the source Moodle course (from .env MOODLE_URL/COURSE_ID) into a round-trip-friendly folder tree (sections, activities, summaries, files).",
  {
    outDir: z.string().default("./kurs").describe("Output directory (default: ./kurs)"),
  },
  ({ outDir }) => text(run(MOODLE_DOWNLOAD_SCRIPT, [outDir], 600_000))
);

server.tool(
  "moodle_upload_course_plan",
  "Print the moodle-updater.js commands that would re-create a downloaded course in the target course (.env MOODLE_URL/COURSE_ID). No HTTP calls — pure plan output.",
  {
    kursDir: z.string().default("./kurs").describe("Path to downloaded course tree (default: ./kurs)"),
  },
  ({ kursDir }) => text(run(MOODLE_UPLOAD_PLAN_SCRIPT, [kursDir]))
);

server.tool(
  "moodle_execute_upload",
  "Append-only uploader: walks a downloaded course tree and appends each source section as a NEW section at the end of the target course. Existing sections are never touched. Without live=true runs as dry-run.",
  {
    kursDir: z.string().default("./kurs").describe("Path to downloaded course tree (default: ./kurs)"),
    section: z.string().optional().describe("Only upload this single source section by folder prefix (e.g. \"01\")"),
    live: z.boolean().default(false).describe("Set true to actually execute (default: dry-run)"),
  },
  ({ kursDir, section, live }) =>
    text(run(MOODLE_EXECUTE_UPLOAD_SCRIPT, [
      kursDir,
      ...(section ? ["--section", section] : []),
      ...(live ? ["--live"] : []),
    ], 1_800_000))
);

// ===========================================================================
//  KAHOOT TOOLS
// ===========================================================================

server.tool(
  "kahoot_login",
  "Open browser to log in to Kahoot and save token to .env",
  { browser: z.enum(["msedge", "chrome"]).optional().describe("Browser to use for SSO login") },
  ({ browser }) => text(run(KAHOOT_SCRIPT, ["login", ...(browser ? ["--browser", browser] : [])], 120_000))
);

server.tool(
  "kahoot_list",
  "List all Kahoot quizzes",
  {},
  () => text(run(KAHOOT_SCRIPT, ["list"]))
);

server.tool(
  "kahoot_preview",
  "Validate and preview a Kahoot quiz JSON definition",
  { quizFile: z.string().describe("Path to quiz JSON file") },
  ({ quizFile }) => text(run(KAHOOT_SCRIPT, ["preview", quizFile]))
);

server.tool(
  "kahoot_create",
  "Create a Kahoot quiz from JSON (dry-run unless live=true)",
  {
    quizFile: z.string().describe("Path to quiz JSON file"),
    live: z.boolean().default(false).describe("Set true to create the quiz (default: dry-run)"),
  },
  ({ quizFile, live }) =>
    text(run(KAHOOT_SCRIPT, ["create", quizFile, ...(live ? ["--live"] : [])]))
);

server.tool(
  "kahoot_host",
  "Open a Kahoot game lobby in the browser for hosting",
  { identifier: z.string().describe("Quiz UUID, URL, or path to quiz.json") },
  ({ identifier }) => text(run(KAHOOT_SCRIPT, ["host", identifier], 120_000))
);

// ===========================================================================
//  Start server
// ===========================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
