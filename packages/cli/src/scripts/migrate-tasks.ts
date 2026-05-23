import { migrateFlatTasksToDateDirs } from "../core/tasks.js";

// Accept project directories as CLI arguments: node migrate-tasks.js /path/to/project1 /path/to/project2
const projects = process.argv.slice(2);

if (projects.length === 0) {
  console.error("Usage: node migrate-tasks.js <project-dir> [<project-dir> ...]");
  process.exit(1);
}

for (const project of projects) {
  const count = migrateFlatTasksToDateDirs(project);
  console.log(`${project}: moved ${count} task files to date-based directories`);
}
