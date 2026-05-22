import { migrateFlatTasksToDateDirs } from "../core/tasks.js";

const projects = [
  "/path/to/project",
  "/path/to/another-project",
];

for (const project of projects) {
  const count = migrateFlatTasksToDateDirs(project);
  console.log(`${project}: moved ${count} task files to date-based directories`);
}
