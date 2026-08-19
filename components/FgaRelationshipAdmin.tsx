"use client";

import { useMemo, useState } from "react";

export type FgaEntityType = "organization" | "team" | "kb_space" | "kb_doc";

export interface FgaEntityChoice {
  type: FgaEntityType;
  id: string;
  label: string;
  relations: string[];
}

export interface FgaMember {
  userId: string;
  label: string;
}

export interface FgaRelationGroup {
  relation: string;
  members: FgaMember[];
}

export interface FgaEntityRow {
  entityType: FgaEntityType;
  entityId: string;
  label: string;
  groups: FgaRelationGroup[];
}

const GROUP_LABEL: Record<FgaEntityType, string> = {
  organization: "Organization",
  team: "Teams",
  kb_space: "Knowledge-base spaces",
  kb_doc: "Individual documents",
};

function entityKey(type: string, id: string) {
  return `${type}:${id}`;
}

/**
 * The admin's relationship console. Granting writes a Permify relation tuple; revoking
 * deletes one — both through /api/admin/fga, which re-checks the FusionAuth admin role
 * server-side off the verified access token.
 *
 * The table is the live relationship graph. Changes here change what a user's agent can
 * reach on the very next chat turn, cascade included: revoke your own
 * `team:platform#manager` and the same payroll question flips from a filtered answer to
 * `fga: DENIED` with no sign-out, no new token, and no scope change.
 */
export default function FgaRelationshipAdmin({
  entities,
  initial,
}: {
  entities: FgaEntityChoice[];
  initial: FgaEntityRow[];
}) {
  const [table, setTable] = useState<FgaEntityRow[]>(initial);
  const [email, setEmail] = useState("");
  const [entitySel, setEntitySel] = useState(
    entities[0] ? entityKey(entities[0].type, entities[0].id) : ""
  );
  const selectedEntity = useMemo(
    () => entities.find((e) => entityKey(e.type, e.id) === entitySel),
    [entities, entitySel]
  );
  const [relation, setRelation] = useState(entities[0]?.relations[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  function onEntityChange(key: string) {
    setEntitySel(key);
    const ent = entities.find((e) => entityKey(e.type, e.id) === key);
    setRelation(ent?.relations[0] ?? "");
  }

  function upsertMember(
    entityType: string,
    entityId: string,
    rel: string,
    member: FgaMember
  ) {
    setTable((prev) =>
      prev.map((row) => {
        if (row.entityType !== entityType || row.entityId !== entityId) return row;
        return {
          ...row,
          groups: row.groups.map((g) =>
            g.relation === rel
              ? {
                  ...g,
                  members: [
                    ...g.members.filter((m) => m.userId !== member.userId),
                    member,
                  ],
                }
              : g
          ),
        };
      })
    );
  }

  function removeMember(
    entityType: string,
    entityId: string,
    rel: string,
    userId: string
  ) {
    setTable((prev) =>
      prev.map((row) => {
        if (row.entityType !== entityType || row.entityId !== entityId) return row;
        return {
          ...row,
          groups: row.groups.map((g) =>
            g.relation === rel
              ? { ...g, members: g.members.filter((m) => m.userId !== userId) }
              : g
          ),
        };
      })
    );
  }

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEntity) return;
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/fga", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          entityType: selectedEntity.type,
          entityId: selectedEntity.id,
          relation,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't grant that relation.");
        return;
      }
      const member = data.member as {
        userId: string;
        email?: string;
        name?: string;
      };
      upsertMember(selectedEntity.type, selectedEntity.id, relation, {
        userId: member.userId,
        label: member.name ?? member.email ?? member.userId,
      });
      setNotice(
        `Wrote ${selectedEntity.type}:${selectedEntity.id}#${relation} for ${
          member.email ?? member.name
        } (${data.mode} tuple).`
      );
      setEmail("");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(
    entityType: FgaEntityType,
    entityId: string,
    rel: string,
    userId: string
  ) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/fga", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, entityType, entityId, relation: rel }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't revoke that relation.");
        return;
      }
      removeMember(entityType, entityId, rel, userId);
      setNotice(`Deleted ${entityType}:${entityId}#${rel} (${data.mode} tuple).`);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const groupedChoices = (["organization", "team", "kb_space", "kb_doc"] as const)
    .map((type) => ({ type, items: entities.filter((e) => e.type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      {/* Grant form */}
      <form
        onSubmit={grant}
        className="rounded-xl border border-line bg-card p-5 shadow-sm"
      >
        <p className="font-bold text-ink font-[family-name:var(--font-display)]">
          Grant a relation
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          Writes one Permify relation tuple. Granting{" "}
          <code className="font-[family-name:var(--font-mono)] text-xs">
            organization#hr
          </code>{" "}
          cascades to every team&rsquo;s payroll and every employee&rsquo;s PTO —
          without a single per-team grant.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              User email
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Entity
            </span>
            <select
              value={entitySel}
              onChange={(e) => onEntityChange(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              {groupedChoices.map((group) => (
                <optgroup key={group.type} label={GROUP_LABEL[group.type]}>
                  {group.items.map((e) => (
                    <option
                      key={entityKey(e.type, e.id)}
                      value={entityKey(e.type, e.id)}
                    >
                      {e.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Relation
            </span>
            <select
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            >
              {(selectedEntity?.relations ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-ink disabled:opacity-50"
            >
              {busy ? "Working…" : "Grant relation"}
            </button>
          </div>
        </div>

        {selectedEntity ? (
          <p className="mt-3 text-xs text-ink-soft font-[family-name:var(--font-mono)]">
            {selectedEntity.type}:{selectedEntity.id}#{relation}@user:&lt;resolved from
            email&gt;
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 text-sm font-medium text-denied" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-3 text-sm font-medium text-verified">{notice}</p>
        ) : null}
      </form>

      {/* Live relationship table */}
      <div className="space-y-4">
        {table.map((row) => (
          <div
            key={entityKey(row.entityType, row.entityId)}
            className="rounded-xl border border-line bg-card p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-ink font-[family-name:var(--font-display)]">
                {row.label}
              </span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-soft font-[family-name:var(--font-mono)]">
                {row.entityType}:{row.entityId}
              </span>
            </div>

            <div className="mt-3 space-y-3">
              {row.groups.map((group) => (
                <div key={group.relation}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    {group.relation}
                  </p>
                  {group.members.length === 0 ? (
                    <p className="mt-1 text-sm text-ink-soft">— none —</p>
                  ) : (
                    <ul className="mt-1 divide-y divide-line">
                      {group.members.map((m) => (
                        <li
                          key={m.userId}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink">{m.label}</p>
                            <p className="truncate text-[11px] text-ink-soft font-[family-name:var(--font-mono)]">
                              user:{m.userId}
                            </p>
                          </div>
                          <button
                            onClick={() =>
                              revoke(
                                row.entityType,
                                row.entityId,
                                group.relation,
                                m.userId
                              )
                            }
                            disabled={busy}
                            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-surface disabled:opacity-50"
                          >
                            Revoke
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
