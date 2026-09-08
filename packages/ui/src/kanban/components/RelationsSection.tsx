import React, { useState, useCallback } from "react";
import type { Task, TaskLinkType } from "../types";
import { shortId, groupDetailRelations, getStatusColor } from "../task-links";
import type { DetailRelationRow } from "../task-links";
import { TASK_LINK_TYPES } from "../types";
import { RecursiveChildrenTree } from "./RecursiveChildrenTree";

interface RelationsSectionProps {
        task: Task;
        allTasks: Task[];
        onUpdateLinks: (links: Task["links"]) => void;
        onOpenTask?: (task: Task) => void;
}

const TYPE_LABELS: Record<TaskLinkType, string> = {
        parent: "Child of →",
        relates: "related",
        blocks: "blocks",
};

/** Badge labels for existing relation rows (distinct from picker labels). */
const TYPE_BADGE_LABELS: Record<TaskLinkType, string> = {
        parent: "↑ parent",
        relates: "related",
        blocks: "blocks",
};

/** Colors per relation type — parent is blue (matches children), relates purple, blocks red. */
const TYPE_COLORS: Record<TaskLinkType, string> = {
        parent: "#60a5fa",
        relates: "#a78bfa",
        blocks: "#f87171",
};

/* ── Component ────────────────────────────────────────────────────────────── */

/** Module-scope variable so the collapsed/open state survives per-selection remounts. */
let relationsAreaOpen = false;

export default function RelationsSection({
        task,
        allTasks,
        onUpdateLinks,
        onOpenTask,
}: RelationsSectionProps) {
        const [open, setOpen] = useState(relationsAreaOpen);
        const [adding, setAdding] = useState(false);
        const [linkType, setLinkType] = useState<TaskLinkType>("relates");
        const [search, setSearch] = useState("");

        const toggleOpen = useCallback(() => {
                setOpen((prev) => {
                        relationsAreaOpen = !prev;
                        return relationsAreaOpen;
                });
        }, []);

        const expand = useCallback(() => {
                if (!open) {
                        relationsAreaOpen = true;
                        setOpen(true);
                }
        }, [open]);

        const links = task.links ?? [];

        const groups = groupDetailRelations(task, allTasks);
        const totalCount = groups.children.length + links.length;

        const searchResults = search.trim()
                ? allTasks.filter(
                          (t) =>
                                  t.id !== task.id &&
                                  (t.id
                                          .toLowerCase()
                                          .includes(search.toLowerCase()) ||
                                          (t.title ?? "")
                                                  .toLowerCase()
                                                  .includes(
                                                          search.toLowerCase(),
                                                  )),
                  )
                : [];

        const handleAdd = useCallback(
                (targetId: string) => {
                        const newLinks = [
                                ...links,
                                { taskId: targetId, type: linkType },
                        ];
                        onUpdateLinks(newLinks);
                        setAdding(false);
                        setSearch("");
                },
                [links, linkType, onUpdateLinks],
        );

        const handleRemove = useCallback(
                (idx: number) => {
                        const newLinks = links.filter((_, i) => i !== idx);
                        onUpdateLinks(newLinks);
                },
                [links, onUpdateLinks],
        );

        const allGroupsEmpty =
                groups.children.length === 0 &&
                groups.parentLinks.length === 0 &&
                groups.blocksLinks.length === 0 &&
                groups.relatesLinks.length === 0;

        return (
                <div className="relations-section" data-role="relations-area">
                        {/* ── Header toggle ── */}
                        <button
                                className="relations-area-header"
                                data-role="relations-area-toggle"
                                aria-expanded={open}
                                onClick={toggleOpen}
                        >
                                <span className="relations-area-title">
                                        Relations
                                </span>
                                <span className="relations-area-count">
                                        {totalCount}
                                </span>
                                <span className="block-chevron">▶</span>
                        </button>

                        {/* ── Expanded body ── */}
                        {open && (
                                <div
                                        className="relations-area-body"
                                        data-role="relations-area-body"
                                >
                                        {/* ── CHILDREN group ── */}
                                        {groups.children.length > 0 && (
                                                <div
                                                        className="relation-group relation-group--children"
                                                        data-role="relation-group-children"
                                                >
                                                        <div className="relation-group-header">
                                                                <span className="relation-group-dot" />
                                                                <span className="relation-group-label">
                                                                        CHILDREN
                                                                        ·{" "}
                                                                        {
                                                                                groups
                                                                                        .children
                                                                                        .length
                                                                        }
                                                                </span>
                                                        </div>
                                                        <div className="relation-group-rows">
                                                                <RecursiveChildrenTree
                                                                        parentId={
                                                                                task.id
                                                                        }
                                                                        allTasks={
                                                                                allTasks
                                                                        }
                                                                        variant="detail"
                                                                        onOpen={(
                                                                                child,
                                                                        ) =>
                                                                                onOpenTask?.(
                                                                                        child,
                                                                                )
                                                                        }
                                                                />
                                                        </div>
                                                </div>
                                        )}

                                        {/* ── PARENT LINKS group (explicit "child of →" links on this task) ── */}
                                        {groups.parentLinks.length > 0 && (
                                                <div
                                                        className="relation-group relation-group--parent"
                                                        data-role="relation-group-parent"
                                                >
                                                        <div className="relation-group-header">
                                                                <span
                                                                        className="relation-group-dot"
                                                                        style={{
                                                                                backgroundColor:
                                                                                        "#60a5fa",
                                                                        }}
                                                                />
                                                                <span className="relation-group-label">
                                                                        PARENT ·{" "}
                                                                        {
                                                                                groups
                                                                                        .parentLinks
                                                                                        .length
                                                                        }
                                                                </span>
                                                        </div>
                                                        <div className="relation-group-rows">
                                                                {groups.parentLinks.map(
                                                                        (
                                                                                row,
                                                                        ) => (
                                                                                <RelationRow
                                                                                        key={`${row.link.taskId}-${row.linkIndex}`}
                                                                                        row={
                                                                                                row
                                                                                        }
                                                                                        onOpen={
                                                                                                onOpenTask
                                                                                        }
                                                                                        onRemove={() =>
                                                                                                handleRemove(
                                                                                                        row.linkIndex,
                                                                                                )
                                                                                        }
                                                                                />
                                                                        ),
                                                                )}
                                                        </div>
                                                </div>
                                        )}

                                        {/* ── BLOCKS group ── */}
                                        {groups.blocksLinks.length > 0 && (
                                                <div
                                                        className="relation-group relation-group--blocks"
                                                        data-role="relation-group-blocks"
                                                >
                                                        <div className="relation-group-header">
                                                                <span className="relation-group-dot" />
                                                                <span className="relation-group-label">
                                                                        BLOCKS ·{" "}
                                                                        {
                                                                                groups
                                                                                        .blocksLinks
                                                                                        .length
                                                                        }
                                                                </span>
                                                        </div>
                                                        <div className="relation-group-rows">
                                                                {groups.blocksLinks.map(
                                                                        (
                                                                                row,
                                                                        ) => (
                                                                                <RelationRow
                                                                                        key={`${row.link.taskId}-${row.linkIndex}`}
                                                                                        row={
                                                                                                row
                                                                                        }
                                                                                        onOpen={
                                                                                                onOpenTask
                                                                                        }
                                                                                        onRemove={() =>
                                                                                                handleRemove(
                                                                                                        row.linkIndex,
                                                                                                )
                                                                                        }
                                                                                />
                                                                        ),
                                                                )}
                                                        </div>
                                                </div>
                                        )}

                                        {/* ── RELATED group ── */}
                                        {groups.relatesLinks.length > 0 && (
                                                <div
                                                        className="relation-group relation-group--relates"
                                                        data-role="relation-group-relates"
                                                >
                                                        <div className="relation-group-header">
                                                                <span className="relation-group-dot" />
                                                                <span className="relation-group-label">
                                                                        RELATED
                                                                        ·{" "}
                                                                        {
                                                                                groups
                                                                                        .relatesLinks
                                                                                        .length
                                                                        }
                                                                </span>
                                                        </div>
                                                        <div className="relation-group-rows">
                                                                {groups.relatesLinks.map(
                                                                        (
                                                                                row,
                                                                        ) => (
                                                                                <RelationRow
                                                                                        key={`${row.link.taskId}-${row.linkIndex}`}
                                                                                        row={
                                                                                                row
                                                                                        }
                                                                                        onOpen={
                                                                                                onOpenTask
                                                                                        }
                                                                                        onRemove={() =>
                                                                                                handleRemove(
                                                                                                        row.linkIndex,
                                                                                                )
                                                                                        }
                                                                                />
                                                                        ),
                                                                )}
                                                        </div>
                                                </div>
                                        )}

                                        {/* ── Empty state: just show the add button ── */}
                                        {allGroupsEmpty && !adding && (
                                                <div className="relations-area-empty">
                                                        No relations yet
                                                </div>
                                        )}

                                        {/* ── + Add relation (last row inside body) ── */}
                                        {!adding && (
                                                <button
                                                        className="relations-add-btn"
                                                        data-role="relations-add"
                                                        onClick={() => {
                                                                setAdding(true);
                                                                expand();
                                                        }}
                                                >
                                                        + Add
                                                </button>
                                        )}

                                        {/* ── Add panel ── */}
                                        {adding && (
                                                <div className="relations-add-panel">
                                                        <div className="relations-type-picker">
                                                                {TASK_LINK_TYPES.map(
                                                                        (t) => (
                                                                                <button
                                                                                        key={
                                                                                                t
                                                                                        }
                                                                                        className={`relations-type-btn ${linkType === t ? "active" : ""}`}
                                                                                        style={
                                                                                                linkType ===
                                                                                                t
                                                                                                        ? {
                                                                                                                  borderColor:
                                                                                                                          TYPE_COLORS[
                                                                                                                                  t
                                                                                                                          ],
                                                                                                                  color: TYPE_COLORS[
                                                                                                                          t
                                                                                                                  ],
                                                                                                          }
                                                                                                        : undefined
                                                                                        }
                                                                                        onClick={() =>
                                                                                                setLinkType(
                                                                                                        t,
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                TYPE_LABELS[
                                                                                                        t
                                                                                                ]
                                                                                        }
                                                                                </button>
                                                                        ),
                                                                )}
                                                        </div>
                                                        {linkType ===
                                                                "parent" && (
                                                                <div className="relations-hint">
                                                                        This
                                                                        task
                                                                        becomes
                                                                        a child
                                                                        of the
                                                                        selected
                                                                        task.
                                                                </div>
                                                        )}
                                                        <input
                                                                className="relations-search"
                                                                placeholder="Search by id or title..."
                                                                value={search}
                                                                onChange={(e) =>
                                                                        setSearch(
                                                                                e
                                                                                        .target
                                                                                        .value,
                                                                        )
                                                                }
                                                                autoFocus
                                                        />
                                                        {searchResults.length >
                                                                0 && (
                                                                <div className="relations-results">
                                                                        {searchResults
                                                                                .slice(
                                                                                        0,
                                                                                        10,
                                                                                )
                                                                                .map(
                                                                                        (
                                                                                                t,
                                                                                        ) => (
                                                                                                <button
                                                                                                        key={
                                                                                                                t.id
                                                                                                        }
                                                                                                        className="relation-result-row"
                                                                                                        onClick={() =>
                                                                                                                handleAdd(
                                                                                                                        t.id,
                                                                                                                )
                                                                                                        }
                                                                                                >
                                                                                                        <span
                                                                                                                className="relation-status-dot"
                                                                                                                style={{
                                                                                                                        backgroundColor:
                                                                                                                                getStatusColor(
                                                                                                                                        t.status,
                                                                                                                                ),
                                                                                                                }}
                                                                                                        />
                                                                                                        <span className="relation-id">
                                                                                                                {shortId(
                                                                                                                        t.id,
                                                                                                                )}
                                                                                                        </span>
                                                                                                        <span className="relation-title">
                                                                                                                {
                                                                                                                        t.title
                                                                                                                }
                                                                                                        </span>
                                                                                                </button>
                                                                                        ),
                                                                                )}
                                                                </div>
                                                        )}
                                                        <button
                                                                className="relations-cancel-btn"
                                                                onClick={() => {
                                                                        setAdding(
                                                                                false,
                                                                        );
                                                                        setSearch(
                                                                                "",
                                                                        );
                                                                }}
                                                        >
                                                                Cancel
                                                        </button>
                                                </div>
                                        )}
                                </div>
                        )}
                </div>
        );
}

/* ── Inline helpers ───────────────────────────────────────────────────────── */

function RelationRow({
        row,
        onOpen,
        onRemove,
}: {
        row: DetailRelationRow;
        onOpen?: (task: Task) => void;
        onRemove: () => void;
}) {
        const { target, link } = row;
        return (
                <div
                        className={`relation-row${target ? " relation-row--clickable" : ""}`}
                        data-role="relation-row"
                        data-task-id={target ? link.taskId : undefined}
                        role={target ? "button" : undefined}
                        tabIndex={target ? 0 : undefined}
                        style={target ? { cursor: "pointer" } : undefined}
                        onClick={
                                target
                                        ? (e) => {
                                                  e.stopPropagation();
                                                  onOpen?.(target);
                                          }
                                        : undefined
                        }
                        onKeyDown={
                                target
                                        ? (e) => {
                                                  if (
                                                          e.key === "Enter" ||
                                                          e.key === " "
                                                  ) {
                                                          e.preventDefault();
                                                          e.stopPropagation();
                                                          onOpen?.(target);
                                                  }
                                          }
                                        : undefined
                        }
                >
                        <span
                                className="relation-type-badge"
                                style={{
                                        backgroundColor:
                                                TYPE_COLORS[
                                                        link.type as TaskLinkType
                                                ] + "22",
                                        color: TYPE_COLORS[
                                                link.type as TaskLinkType
                                        ],
                                }}
                        >
                                {TYPE_BADGE_LABELS[link.type as TaskLinkType]}
                        </span>
                        {target ? (
                                <>
                                        <span
                                                className="relation-status-dot"
                                                style={{
                                                        backgroundColor:
                                                                getStatusColor(
                                                                        target.status,
                                                                ),
                                                }}
                                        />
                                        <span className="relation-id">
                                                {shortId(target.id)}
                                        </span>
                                        <span className="relation-title">
                                                {target.title}
                                        </span>
                                </>
                        ) : (
                                <span className="relation-dangling">
                                        not found ({shortId(link.taskId)})
                                </span>
                        )}
                        <button
                                className="relation-remove"
                                onClick={(e) => {
                                        e.stopPropagation();
                                        onRemove();
                                }}
                                title="Remove link"
                        >
                                ×
                        </button>
                </div>
        );
}
