import React from "react";
import { HeaderActionButton } from "@vibeflow-tools/ui/kanban";
import { api } from "./api.js";
import {
  computeBoardOverview,
  OVERVIEW_STATUSES,
  type OverviewStaleTask,
} from "./overview.js";

/**
 * WHAT: read-only board overview page for the CLI kanban server
 * (ticket 717d6335) — status counts, done today/this week, oldest
 * todo/in-progress (staleness), and an assignee breakdown.
 * WHY this shape: it aggregates client-side from the SAME GET /api/tasks
 * payload the board columns use (see overview.ts) — no new data layer.
 * READ-ONLY: no mutations, no drag; every card reference links back into
 * the board via `/kanban#task-<id>`. Styling uses only the shared theme
 * tokens (`var(--t-*)`), never hardcoded colors, so dark/light themes apply
 * unchanged. Numbers render as real `<table>`s with captions and scoped
 * headers for accessible list/table semantics.
 */

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

function tableStyle(): React.CSSProperties {
  return {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    background: "var(--t-card)",
    border: "1px solid var(--t-border)",
    borderRadius: 10,
    overflow: "hidden",
  };
}

function thStyle(): React.CSSProperties {
  return {
    textAlign: "left",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--t-text-muted)",
    padding: "8px 12px",
    borderBottom: "1px solid var(--t-border)",
  };
}

function tdStyle(): React.CSSProperties {
  return {
    padding: "8px 12px",
    color: "var(--t-text)",
    borderBottom: "1px solid var(--t-border-faint)",
  };
}

function sectionTitleStyle(): React.CSSProperties {
  return {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--t-text)",
    margin: "0 0 8px",
  };
}

function StaleRow({ task }: { task: OverviewStaleTask | null }) {
  if (!task) {
    return (
      <tr>
        <td colSpan={3} style={{ ...tdStyle(), color: "var(--t-text-muted)" }}>
          None
        </td>
      </tr>
    );
  }
  return (
    <tr data-testid={`overview-oldest-${task.status}`}>
      <td style={tdStyle()}>
        <a
          href={`/kanban#task-${task.id}`}
          style={{ color: "var(--t-accent)", textDecoration: "none" }}
        >
          {task.title}
        </a>
      </td>
      <td style={{ ...tdStyle(), color: "var(--t-text-muted)" }}>
        {task.ageDays === 0
          ? "today"
          : `${task.ageDays} day${task.ageDays === 1 ? "" : "s"} ago`}
      </td>
      <td
        style={{
          ...tdStyle(),
          color: "var(--t-text-faint)",
          fontFamily: "monospace",
          fontSize: 11,
        }}
      >
        {task.id.slice(0, 8)}
      </td>
    </tr>
  );
}

export function OverviewPage() {
  const [tasks, setTasks] = React.useState<
    import("@vibeflow-tools/ui/kanban").Task[]
  >([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void api
      .getTasks()
      .then((data) => {
        if (cancelled) return;
        setTasks(data.tasks ?? []);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load tasks");
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const overview = React.useMemo(() => computeBoardOverview(tasks), [tasks]);

  return (
    <div
      className="h-screen overflow-auto flex flex-col"
      style={{ background: "var(--t-bg)" }}
    >
      <header className="px-5 py-3 flex items-center gap-3 border-b kb-header-border flex-shrink-0">
        <a
          id="overview-back-link"
          href="/kanban"
          className="text-xs kb-nav-link transition-colors"
          style={{ textDecoration: "none", fontWeight: 500 }}
        >
          ← Back to board
        </a>
        <h1
          id="overview-title"
          className="text-sm font-semibold kb-title leading-tight"
        >
          Board overview
        </h1>
        <div className="flex-1" />
        <HeaderActionButton
          id="overview-refresh-btn"
          title="Reload overview numbers"
          label="Refresh"
          onClick={() => {
            setIsLoading(true);
            setLoadError("");
            void api
              .getTasks()
              .then((data) => {
                setTasks(data.tasks ?? []);
                setIsLoading(false);
              })
              .catch((e: unknown) => {
                setLoadError(
                  e instanceof Error ? e.message : "Failed to load tasks",
                );
                setIsLoading(false);
              });
          }}
        />
      </header>

      <main
        className="flex-1 px-5 py-4"
        style={{ maxWidth: 860, width: "100%", margin: "0 auto" }}
      >
        {loadError ? (
          <p
            role="alert"
            style={{ color: "var(--t-danger)", fontSize: 13 }}
          >
            {loadError}
          </p>
        ) : isLoading ? (
          <p style={{ color: "var(--t-text-muted)", fontSize: 13 }}>
            Loading board numbers…
          </p>
        ) : (
          <>
            <section aria-labelledby="overview-status-heading">
              <h2 id="overview-status-heading" style={sectionTitleStyle()}>
                Tasks by status · {overview.total} total
              </h2>
              <table
                data-testid="overview-status-table"
                style={tableStyle()}
              >
                <caption className="sr-only">
                  Number of tasks in each board column
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle()}>
                      Status
                    </th>
                    <th scope="col" style={thStyle()}>
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {OVERVIEW_STATUSES.map((status) => (
                    <tr
                      key={status}
                      data-testid={`overview-status-${status}`}
                    >
                      <th scope="row" style={{ ...tdStyle(), fontWeight: 500 }}>
                        {STATUS_LABELS[status] ?? status}
                      </th>
                      <td style={tdStyle()}>{overview.countsByStatus[status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section
              aria-labelledby="overview-throughput-heading"
              style={{ marginTop: 24 }}
            >
              <h2 id="overview-throughput-heading" style={sectionTitleStyle()}>
                Throughput
              </h2>
              <table
                data-testid="overview-throughput-table"
                style={tableStyle()}
              >
                <caption className="sr-only">
                  Tasks completed today and in the last seven days
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle()}>
                      Window
                    </th>
                    <th scope="col" style={thStyle()}>
                      Done
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" style={{ ...tdStyle(), fontWeight: 500 }}>
                      Today
                    </th>
                    <td data-testid="overview-done-today" style={tdStyle()}>
                      {overview.doneToday}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={{ ...tdStyle(), fontWeight: 500 }}>
                      Last 7 days
                    </th>
                    <td data-testid="overview-done-week" style={tdStyle()}>
                      {overview.doneThisWeek}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section
              aria-labelledby="overview-staleness-heading"
              style={{ marginTop: 24 }}
            >
              <h2 id="overview-staleness-heading" style={sectionTitleStyle()}>
                Oldest open work
              </h2>
              <table
                data-testid="overview-staleness-table"
                style={tableStyle()}
              >
                <caption className="sr-only">
                  Oldest todo and in-progress tasks by creation date
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle()}>
                      Task
                    </th>
                    <th scope="col" style={thStyle()}>
                      Age
                    </th>
                    <th scope="col" style={thStyle()}>
                      ID
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <StaleRow task={overview.oldestTodo} />
                  <StaleRow task={overview.oldestInProgress} />
                </tbody>
              </table>
            </section>

            <section
              aria-labelledby="overview-assignees-heading"
              style={{ marginTop: 24 }}
            >
              <h2 id="overview-assignees-heading" style={sectionTitleStyle()}>
                By assignee
              </h2>
              {overview.assignees.length === 0 ? (
                <p style={{ color: "var(--t-text-muted)", fontSize: 13 }}>
                  No tasks yet.
                </p>
              ) : (
                <table
                  data-testid="overview-assignee-table"
                  style={tableStyle()}
                >
                  <caption className="sr-only">
                    Task counts per task author
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" style={thStyle()}>
                        Assignee
                      </th>
                      <th scope="col" style={thStyle()}>
                        Total
                      </th>
                      <th scope="col" style={thStyle()}>
                        Open
                      </th>
                      <th scope="col" style={thStyle()}>
                        Done
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.assignees.map((row) => (
                      <tr
                        key={row.name}
                        data-testid={`overview-assignee-${row.name}`}
                      >
                        <th scope="row" style={{ ...tdStyle(), fontWeight: 500 }}>
                          {row.name}
                        </th>
                        <td style={tdStyle()}>{row.total}</td>
                        <td style={tdStyle()}>{row.open}</td>
                        <td style={tdStyle()}>{row.done}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
