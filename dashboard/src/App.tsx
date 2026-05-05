import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  SendHorizontal,
  Settings,
} from "lucide-react";
import { Toaster, toast } from "sonner";

import edgeServerAsset from "./assets/edge-server.png";
import userAsset from "./assets/user.png";
import dbAsset from "./assets/db.avif";
import {
  EdgeKey,
  GenerateResponse,
  HealthResponse,
  exportHandoverPackage,
  fetchEdgeHealth,
  fetchEdgeUserState,
  fetchRuntimeSettings,
  generate,
  importHandoverPackage,
  updateRuntimeSettings,
} from "./lib/api";

type UserId = 1 | 2 | 3;

type UserState = {
  id: UserId;
  x: number;
  movingFromX?: number;
  movingToX?: number;
  movingStartedAt?: number;
  selected: boolean;
  moving: "left" | "right" | null;
  sessionId?: string;
  lastMessageAt?: string;
  requestCount: number;
  active: boolean;
  lastCachePhase: "cold" | "hot" | "idle";
  lastEdge?: EdgeKey;
  lastMemorySource?: string;
  lastTotalMs?: number;
  lastInferenceExcludedMs?: number | null;
};

type UserEdgeState = {
  stm: boolean;
  ltmCached: boolean;
  ltmCount: number;
  cachePhase: "idle" | "cold" | "hot" | "prefetched";
  stmExpiresAt?: number;
  ltmExpiresAt?: number;
  stmMessages: Array<{ role: string; content: string; timestamp?: number }>;
  ltmMemories: string[];
  lastSeen?: string;
};

type EdgePanelState = Record<UserId, UserEdgeState>;
type TransferEndpoint = EdgeKey | "global";

type TransferNotice = {
  id: number;
  from: TransferEndpoint;
  to: TransferEndpoint;
  text: string;
};

const usersInitial: UserState[] = [
  {
    id: 1,
    x: 0.24,
    selected: true,
    moving: null,
    requestCount: 0,
    active: false,
    lastCachePhase: "idle",
  },
  {
    id: 2,
    x: 0.24,
    selected: false,
    moving: null,
    requestCount: 0,
    active: false,
    lastCachePhase: "idle",
  },
  {
    id: 3,
    x: 0.24,
    selected: false,
    moving: null,
    requestCount: 0,
    active: false,
    lastCachePhase: "idle",
  },
];

const emptyEdgePanel: EdgePanelState = {
  1: {
    stm: false,
    ltmCached: false,
    ltmCount: 0,
    cachePhase: "idle",
    stmMessages: [],
    ltmMemories: [],
  },
  2: {
    stm: false,
    ltmCached: false,
    ltmCount: 0,
    cachePhase: "idle",
    stmMessages: [],
    ltmMemories: [],
  },
  3: {
    stm: false,
    ltmCached: false,
    ltmCount: 0,
    cachePhase: "idle",
    stmMessages: [],
    ltmMemories: [],
  },
};

const userColors: Record<UserId, string> = {
  1: "#68f1aa",
  2: "#b4d1ff",
  3: "#ffaeae",
};

const edgeIdByKey: Record<EdgeKey, string> = {
  left: "edge-node-left",
  right: "edge-node-right",
};

const oppositeEdgeId: Record<EdgeKey, string> = {
  left: "edge-node-right",
  right: "edge-node-left",
};

export default function App() {
  const [users, setUsers] = useState<UserState[]>(usersInitial);
  const [message, setMessage] = useState("");
  const [health, setHealth] = useState<Record<EdgeKey, HealthResponse | null>>({
    left: null,
    right: null,
  });
  const [edgePanel, setEdgePanel] = useState<Record<EdgeKey, EdgePanelState>>({
    left: emptyEdgePanel,
    right: emptyEdgePanel,
  });
  const [transferNotice, setTransferNotice] = useState<TransferNotice | null>(
    null,
  );
  const [nowMs, setNowMs] = useState(Date.now());
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    sessionTtlSeconds: 120,
    ltmCacheTtlSeconds: 300,
  });

  const selectedUser = useMemo(
    () => users.find((user) => user.selected) ?? users[0],
    [users],
  );

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const [left, right] = await Promise.allSettled([
        fetchEdgeHealth("left"),
        fetchEdgeHealth("right"),
      ]);

      const healthByEdge: Record<EdgeKey, HealthResponse | null> = {
        left: left.status === "fulfilled" ? left.value : null,
        right: right.status === "fulfilled" ? right.value : null,
      };

      if (!cancelled) {
        setHealth(healthByEdge);
      }

      const nextPanel: Record<EdgeKey, EdgePanelState> = {
        left: cloneEdgePanel(emptyEdgePanel),
        right: cloneEdgePanel(emptyEdgePanel),
      };

      await Promise.all(
        users.flatMap((user) =>
          (["left", "right"] as EdgeKey[]).map(async (edge) => {
            try {
              const state = await fetchEdgeUserState(edge, {
                userId: userId(user.id),
                sessionId: user.sessionId,
              });
              const sessionTtlMs =
                (healthByEdge[edge]?.localSessionRegistry?.ttlSeconds ?? 0) *
                1000;
              const stmLastActiveAtMs =
                typeof state.stm?.lastActiveAt === "number"
                  ? state.stm.lastActiveAt * 1000
                  : Date.now();
              const ltmExpiresAtMs =
                typeof state.ltm.expiresAt === "number"
                  ? state.ltm.expiresAt * 1000
                  : undefined;
              nextPanel[edge][user.id] = {
                stm: state.stm !== null,
                ltmCached: state.ltm.present,
                ltmCount: state.ltm.memories.length,
                cachePhase: "idle",
                stmExpiresAt:
                  state.stm !== null && sessionTtlMs > 0
                    ? stmLastActiveAtMs + sessionTtlMs
                    : undefined,
                ltmExpiresAt: ltmExpiresAtMs,
                stmMessages: state.stm?.messages ?? [],
                ltmMemories: state.ltm.memories,
                lastSeen: new Date().toLocaleTimeString(),
              };
            } catch {
              nextPanel[edge][user.id] = {
                stm: false,
                ltmCached: false,
                ltmCount: 0,
                cachePhase: "idle",
                stmExpiresAt: undefined,
                ltmExpiresAt: undefined,
                stmMessages: [],
                ltmMemories: [],
              };
            }
          }),
        ),
      );

      if (!cancelled) {
        setEdgePanel((current) => {
          const persistenceNotices = collectPersistenceNotices(
            current,
            nextPanel,
          );
          window.setTimeout(() => {
            persistenceNotices.forEach((notice) => showTransferNotice(notice));
          }, 0);
          return mergeEdgePanelPoll(current, nextPanel);
        });
      }
    }

    poll();
    const interval = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [users]);

  useEffect(() => {
    const ttlSeconds = Math.min(
      health.left?.stm?.activeSessions !== undefined
        ? (health.left.localSessionRegistry?.ttlSeconds ??
            Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY,
      health.right?.stm?.activeSessions !== undefined
        ? (health.right.localSessionRegistry?.ttlSeconds ??
            Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY,
    );

    if (!Number.isFinite(ttlSeconds)) {
      return;
    }

    const now = Date.now();
    setUsers((current) =>
      current.map((user) => {
        if (!user.lastMessageAt) {
          return user;
        }

        const ageMs = now - new Date(user.lastMessageAt).getTime();
        if (ageMs < ttlSeconds * 1000) {
          return user;
        }

        return {
          ...user,
          sessionId: undefined,
          lastMessageAt: undefined,
          requestCount: 0,
          active: false,
          lastCachePhase: "idle",
          lastMemorySource: undefined,
          lastTotalMs: undefined,
          lastInferenceExcludedMs: undefined,
        };
      }),
    );
  }, [health.left, health.right]);

  function selectUser(id: UserId) {
    setUsers((current) =>
      current.map((user) => ({
        ...user,
        selected: user.id === id,
      })),
    );
  }

  async function triggerPretransfer(
    user: UserState,
    source: EdgeKey,
    target: EdgeKey,
  ) {
    if (!user.sessionId) {
      showTransferNotice({
        from: source,
        to: target,
        text: `pretransfer skipped user-${user.id}: no active session on ${edgeIdByKey[source]}`,
      });
      return;
    }

    try {
      const exported = await exportHandoverPackage(source, {
        userId: userId(user.id),
        sessionId: user.sessionId,
        targetEdgeId: edgeIdByKey[target],
      });
      const imported = await importHandoverPackage(target, exported.package);
      setEdgePanel((current) => ({
        ...current,
        [target]: {
          ...current[target],
          [user.id]: {
            stm: imported.stmImported,
            ltmCached: true,
            ltmCount: imported.ltmCount,
            cachePhase: "prefetched",
            stmExpiresAt: imported.stmImported
              ? Date.now() + getSessionTtlMs(target)
              : undefined,
            ltmExpiresAt: Date.now() + getLtmTtlMs(target),
            stmMessages: exported.package.stm?.messages ?? [],
            ltmMemories: exported.package.ltm,
            lastSeen: new Date().toLocaleTimeString(),
          },
        },
      }));
      showTransferNotice({
        from: source,
        to: target,
        text: `pretransfer user-${user.id}: ${edgeIdByKey[source]} -> ${edgeIdByKey[target]}, STM ${imported.stmImported ? "yes" : "no"}, LTM ${imported.ltmCount}`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showTransferNotice({
        from: source,
        to: target,
        text: `pretransfer failed user-${user.id}: ${detail}`,
      });
    }
  }

  function moveSelected(direction: "left" | "right") {
    const movingUserId = selectedUser.id;
    const currentX = currentUserX(selectedUser);
    const source = nearestEdge(currentX);
    const target = direction === "right" ? "right" : "left";
    const targetX = direction === "right" ? 0.76 : 0.24;

    if (source !== target) {
      void triggerPretransfer(selectedUser, source, target);
    }

    setUsers((current) =>
      current.map((user) => {
        if (user.id !== movingUserId || user.moving) {
          return user;
        }
        const startX = currentUserX(user);
        if (Math.abs(startX - targetX) < 0.02) {
          return user;
        }
        return {
          ...user,
          x: targetX,
          moving: direction,
          movingFromX: startX,
          movingToX: targetX,
          movingStartedAt: Date.now(),
        };
      }),
    );

    window.setTimeout(() => {
      setUsers((current) =>
        current.map((user) =>
          user.id === movingUserId && user.moving === direction
            ? {
                ...user,
                moving: null,
                movingFromX: undefined,
                movingToX: undefined,
                movingStartedAt: undefined,
              }
            : user,
        ),
      );
    }, 10_000);
  }

  function getSessionTtlMs(edge: EdgeKey): number {
    return (health[edge]?.localSessionRegistry?.ttlSeconds ?? 0) * 1000;
  }

  function getLtmTtlMs(edge: EdgeKey): number {
    return (health[edge]?.ltmCache?.ttlSeconds ?? 0) * 1000;
  }

  async function openSettingsDialog() {
    setSettingsDialogOpen(true);

    try {
      const settings = await fetchRuntimeSettings("left");
      setSettingsForm({
        sessionTtlSeconds: settings.sessionTtlSeconds,
        ltmCacheTtlSeconds: settings.ltmCacheTtlSeconds,
      });
    } catch {
      setSettingsForm({
        sessionTtlSeconds:
          health.left?.localSessionRegistry?.ttlSeconds ??
          health.right?.localSessionRegistry?.ttlSeconds ??
          120,
        ltmCacheTtlSeconds:
          health.left?.ltmCache?.ttlSeconds ??
          health.right?.ltmCache?.ttlSeconds ??
          300,
      });
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextSettings = {
      sessionTtlSeconds: Math.max(1, Math.floor(settingsForm.sessionTtlSeconds)),
      ltmCacheTtlSeconds: Math.max(1, Math.floor(settingsForm.ltmCacheTtlSeconds)),
    };

    setSettingsSaving(true);
    try {
      await Promise.all(
        (["left", "right"] as EdgeKey[]).map((edge) =>
          updateRuntimeSettings(edge, nextSettings),
        ),
      );
      setSettingsForm(nextSettings);
      setSettingsDialogOpen(false);
      toast.success(
        `TTL settings applied: session ${nextSettings.sessionTtlSeconds}s, LTM ${nextSettings.ltmCacheTtlSeconds}s`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast.error(`Settings update failed: ${detail}`);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || selectedUser.active) {
      return;
    }

    const edge = nearestEdge(currentUserX(selectedUser));
    const cachePhase = selectedUser.requestCount === 0 ? "cold" : "hot";

    setUsers((current) =>
      current.map((user) =>
        user.id === selectedUser.id
          ? {
              ...user,
              active: true,
              lastCachePhase: cachePhase,
              lastEdge: edge,
            }
          : user,
      ),
    );

    try {
      const response = await generate(edge, {
        userId: userId(selectedUser.id),
        sessionId: selectedUser.sessionId,
        lastMessageTimestamp: selectedUser.lastMessageAt,
        clientDirection: selectedUser.moving ?? undefined,
        clientSpeed: selectedUser.moving ? 1 : undefined,
        prompt: trimmed,
        maxNewTokens: 32,
      });

      updateUserAfterResponse(selectedUser.id, edge, cachePhase, response);
      showMemoryFetchNotice(selectedUser.id, edge, response);
      showTransferNoticeFromResponse(selectedUser.id, edge, response);
      setMessage("");
      toast.success(
        `Answer for user${selectedUser.id}: ${response.output || "(empty)"}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setUsers((current) =>
        current.map((user) =>
          user.id === selectedUser.id ? { ...user, active: false } : user,
        ),
      );
      toast.error(`Request failed for user${selectedUser.id}: ${detail}`);
    }
  }

  function showMemoryFetchNotice(
    id: UserId,
    edge: EdgeKey,
    response: GenerateResponse,
  ) {
    if (response.metrics.memorySource === "memory-layer") {
      showTransferNotice({
        from: "global",
        to: edge,
        text: `initial memory fetch user-${id}: global memory -> ${edgeIdByKey[edge]}`,
      });
    }
  }

  function showTransferNoticeFromResponse(
    id: UserId,
    requestEdge: EdgeKey,
    response: GenerateResponse,
  ) {
    const proactive = response.metrics.proactiveHandover;
    if (proactive?.scheduled && proactive.targetEdgeId) {
      const target = edgeKeyFromEdgeId(proactive.targetEdgeId);
      if (target) {
        showTransferNotice({
          from: requestEdge,
          to: target,
          text: `pretransfer user-${id}: ${edgeIdByKey[requestEdge]} -> ${proactive.targetEdgeId}, STM ${proactive.stmIncluded ? "yes" : "no"}, LTM ${proactive.ltmCount ?? 0}`,
        });
      }
    }

    const recovery = response.metrics.neighborRecovery;
    if (recovery?.attempted && recovery.recovered && recovery.sourceEdgeId) {
      const source = edgeKeyFromEdgeId(recovery.sourceEdgeId);
      if (source) {
        showTransferNotice({
          from: source,
          to: requestEdge,
          text: `nearby fetch user-${id}: ${recovery.sourceEdgeId} -> ${edgeIdByKey[requestEdge]}, STM ${recovery.stmImported ? "yes" : "no"}, LTM ${recovery.ltmCount ?? 0}`,
        });
      }
    }
  }

  function showTransferNotice(params: Omit<TransferNotice, "id">) {
    const noticeId = Date.now();
    setTransferNotice({ id: noticeId, ...params });
    window.setTimeout(() => {
      setTransferNotice((current) =>
        current?.id === noticeId ? null : current,
      );
    }, 7000);
  }

  function updateUserAfterResponse(
    id: UserId,
    edge: EdgeKey,
    cachePhase: "cold" | "hot",
    response: GenerateResponse,
  ) {
    setUsers((current) =>
      current.map((user) =>
        user.id === id
          ? {
              ...user,
              active: false,
              sessionId: response.sessionId,
              lastMessageAt: new Date().toISOString(),
              requestCount: user.requestCount + 1,
              lastCachePhase: cachePhase,
              lastEdge: edge,
              lastMemorySource: response.metrics.memorySource,
              lastTotalMs: response.metrics.totalMs,
              lastInferenceExcludedMs: response.metrics.inferenceExcludedMs,
            }
          : user,
      ),
    );

    const sourceEdge =
      response.metrics.edgeNodeId === "edge-node-right" ? "right" : edge;
    setEdgePanel((current) => ({
      ...current,
      [sourceEdge]: {
        ...current[sourceEdge],
        [id]: {
          stm: true,
          ltmCached: true,
          ltmCount: current[sourceEdge][id].ltmCount,
          cachePhase,
          stmExpiresAt: Date.now() + getSessionTtlMs(sourceEdge),
          ltmExpiresAt: Date.now() + getLtmTtlMs(sourceEdge),
          stmMessages: current[sourceEdge][id].stmMessages,
          ltmMemories: current[sourceEdge][id].ltmMemories,
          lastSeen: new Date().toLocaleTimeString(),
        },
      },
    }));
  }

  return (
    <main className="dashboardShell">
      <Toaster richColors position="bottom-right" />
      <section className="topology" aria-label="Edge topology">
        <GlobalMemory />
        <EdgeNode
          edge="left"
          label="1"
          health={health.left}
          panel={edgePanel.left}
          users={users}
          nowMs={nowMs}
        />
        <EdgeNode
          edge="right"
          label="2"
          health={health.right}
          panel={edgePanel.right}
          users={users}
          nowMs={nowMs}
        />

        {transferNotice ? <TransferArrow notice={transferNotice} /> : null}

        <div className="userLayer" aria-label="Users">
          {users.map((user, index) => (
            <UserMarker
              key={user.id}
              user={user}
              index={index}
              onSelect={() => selectUser(user.id)}
              onMove={moveSelected}
            />
          ))}
        </div>
      </section>

      <form className="messageBar" onSubmit={sendMessage}>
        <input
          aria-label="Message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`Message as user-${selectedUser.id}`}
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!message.trim() || selectedUser.active}
        >
          {selectedUser.active ? (
            <Loader2 className="spinIcon" size={24} />
          ) : (
            <SendHorizontal size={24} />
          )}
        </button>
      </form>

      {/* <button
        type="button"
        className="memoryTrigger"
        onClick={() => setMemoryDialogOpen(true)}
      >
        User {selectedUser.id} memory
      </button> */}

      <button
        type="button"
        className="settingsTrigger"
        aria-label="Open runtime settings"
        onClick={openSettingsDialog}
      >
        <Settings size={20} />
        <span>Settings</span>
      </button>

      {memoryDialogOpen ? (
        <MemoryDialog
          user={selectedUser}
          panel={edgePanel}
          onClose={() => setMemoryDialogOpen(false)}
        />
      ) : null}

      {settingsDialogOpen ? (
        <SettingsDialog
          values={settingsForm}
          saving={settingsSaving}
          onChange={setSettingsForm}
          onClose={() => setSettingsDialogOpen(false)}
          onSubmit={saveSettings}
        />
      ) : null}
    </main>
  );
}

function EdgeNode(props: {
  edge: EdgeKey;
  label: string;
  health: HealthResponse | null;
  panel: EdgePanelState;
  users: UserState[];
  nowMs: number;
}) {
  const online = props.health?.ok === true;

  return (
    <section className={`edgeNode ${props.edge}`}>
      <div className="edgeHeader">
        <span>{props.label}</span>
        <img src={edgeServerAsset} alt="" />
      </div>
      <div className="edgeStatePanel">
        <div className="edgeMeta">
          <span className={online ? "statusOnline" : "statusOffline"}>
            {online ? "online" : "offline"}
          </span>
          <span>{props.health?.edgeNodeId ?? edgeIdByKey[props.edge]}</span>
        </div>
        <div className="edgeMetrics">
          <Metric
            label="active sessions"
            value={props.health?.stm?.activeSessions ?? 0}
          />
          <Metric
            label="ltm cache"
            value={props.health?.ltmCache?.entryCount ?? 0}
          />
          {/* <Metric
            label="local registry"
            value={props.health?.localSessionRegistry?.entryCount ?? 0}
          /> */}
        </div>
        <div className="userStateList">
          {props.users.map((user) => {
            const state = props.panel[user.id];
            const stmActive = isTimerActive(state.stm, state.stmExpiresAt, props.nowMs);
            const ltmActive = isTimerActive(
              state.ltmCached,
              state.ltmExpiresAt,
              props.nowMs,
            );
            const visibleCachePhase =
              stmActive || ltmActive ? state.cachePhase : "idle";
            return (
              <div className="userStateRow" key={user.id}>
                <div className="userStateName">
                  {user.active && user.lastEdge === props.edge ? (
                    <Loader2 className="spinIcon" size={15} />
                  ) : null}
                  <span>User {user.id}</span>
                </div>
                <span>{visibleCachePhase}</span>
                <TimerCell
                  label="STM"
                  active={stmActive}
                  expiresAt={state.stmExpiresAt}
                  ttlSeconds={props.health?.localSessionRegistry?.ttlSeconds}
                  nowMs={props.nowMs}
                />
                <TimerCell
                  label="LTM"
                  active={ltmActive}
                  expiresAt={state.ltmExpiresAt}
                  ttlSeconds={props.health?.ltmCache?.ttlSeconds}
                  nowMs={props.nowMs}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function isTimerActive(
  present: boolean,
  expiresAt: number | undefined,
  nowMs: number,
): boolean {
  if (!present) {
    return false;
  }

  return expiresAt === undefined || expiresAt > nowMs;
}

function TimerCell(props: {
  label: string;
  active: boolean;
  expiresAt?: number;
  ttlSeconds?: number;
  nowMs: number;
}) {
  if (
    !props.active ||
    props.expiresAt === undefined ||
    props.ttlSeconds === undefined
  ) {
    return <span className="timerEmpty">{props.label} --</span>;
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((props.expiresAt - props.nowMs) / 1000),
  );
  const progress =
    props.ttlSeconds > 0
      ? Math.max(0, Math.min(1, remainingSeconds / props.ttlSeconds))
      : 0;

  return (
    <span className="timerCell">
      <span>{props.label}</span>
      <span
        className="timerRing"
        style={{ "--progress": `${progress * 360}deg` } as CSSProperties}
      >
        {remainingSeconds}
      </span>
    </span>
  );
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div className="metricBox">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function MemoryDialog(props: {
  user: UserState;
  panel: Record<EdgeKey, EdgePanelState>;
  onClose: () => void;
}) {
  return (
    <div
      className="memoryDialogBackdrop"
      role="presentation"
      onMouseDown={props.onClose}
    >
      <section
        className="memoryDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Memory for user ${props.user.id}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="memoryDialogHeader">
          <div>
            <strong>User {props.user.id} memory</strong>
            <span>
              {props.user.sessionId
                ? `session ${props.user.sessionId}`
                : "no active session"}
            </span>
          </div>
          <button type="button" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div className="memoryDialogGrid">
          {(["left", "right"] as EdgeKey[]).map((edge) => {
            const state = props.panel[edge][props.user.id];
            return (
              <div className="memoryColumn" key={edge}>
                <h3>{edgeIdByKey[edge]}</h3>
                <section>
                  <h4>STM chat history</h4>
                  {state.stmMessages.length > 0 ? (
                    <div className="memoryList">
                      {state.stmMessages.map((message, index) => (
                        <div
                          className="memoryItem"
                          key={`${edge}-stm-${index}`}
                        >
                          <span>{message.role}</span>
                          <p>{message.content}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="emptyMemory">No STM on this edge.</p>
                  )}
                </section>
                <section>
                  <h4>LTM cache</h4>
                  {state.ltmMemories.length > 0 ? (
                    <div className="memoryList">
                      {state.ltmMemories.map((memory, index) => (
                        <div
                          className="memoryItem"
                          key={`${edge}-ltm-${index}`}
                        >
                          <span>memory {index + 1}</span>
                          <p>{memory}</p>
                        </div>
                      ))}
                    </div>
                  ) : state.ltmCached ? (
                    <p className="emptyMemory">
                      LTM cache is present, but it has no memory strings.
                    </p>
                  ) : (
                    <p className="emptyMemory">No LTM cache on this edge.</p>
                  )}
                </section>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SettingsDialog(props: {
  values: { sessionTtlSeconds: number; ltmCacheTtlSeconds: number };
  saving: boolean;
  onChange: (values: {
    sessionTtlSeconds: number;
    ltmCacheTtlSeconds: number;
  }) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      className="memoryDialogBackdrop"
      role="presentation"
      onMouseDown={props.onClose}
    >
      <form
        className="settingsDialog"
        role="dialog"
        aria-modal="true"
        aria-label="Runtime settings"
        onSubmit={props.onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="memoryDialogHeader">
          <div>
            <strong>Runtime settings</strong>
            <span>Applied to both edge nodes</span>
          </div>
          <button type="button" onClick={props.onClose}>
            Close
          </button>
        </div>

        <label className="settingsField">
          <span>Session / STM TTL seconds</span>
          <input
            type="number"
            min={1}
            step={1}
            value={props.values.sessionTtlSeconds}
            onChange={(event) =>
              props.onChange({
                ...props.values,
                sessionTtlSeconds: Number(event.target.value),
              })
            }
          />
        </label>

        <label className="settingsField">
          <span>LTM cache TTL seconds</span>
          <input
            type="number"
            min={1}
            step={1}
            value={props.values.ltmCacheTtlSeconds}
            onChange={(event) =>
              props.onChange({
                ...props.values,
                ltmCacheTtlSeconds: Number(event.target.value),
              })
            }
          />
        </label>

        <button
          className="settingsSubmit"
          type="submit"
          disabled={
            props.saving ||
            props.values.sessionTtlSeconds < 1 ||
            props.values.ltmCacheTtlSeconds < 1
          }
        >
          {props.saving ? "Applying..." : "Apply globally"}
        </button>
      </form>
    </div>
  );
}

function GlobalMemory() {
  return (
    <section className="globalMemory" aria-label="Global memory database">
      <img src={dbAsset} style={{ width: "6rem" }} />
      <span>Global DB</span>
    </section>
  );
}

function UserMarker(props: {
  user: UserState;
  index: number;
  onSelect: () => void;
  onMove: (direction: "left" | "right") => void;
}) {
  const top = 68 + props.index * 8.4;
  return (
    <div
      className={`userMarker ${props.user.selected ? "selected" : ""} ${props.user.moving ? "moving" : ""}`}
      style={
        {
          left: `${props.user.x * 100}%`,
          top: `${top}%`,
          "--user-color": userColors[props.user.id],
        } as CSSProperties
      }
    >
      {props.user.selected ? (
        <button
          className="moveButton leftMove"
          type="button"
          aria-label="Move selected user left"
          onClick={() => props.onMove("left")}
        >
          <ChevronLeft size={24} />
        </button>
      ) : null}
      <button
        className="userButton"
        type="button"
        aria-label={`Select user ${props.user.id}`}
        onClick={props.onSelect}
      >
        <img src={userAsset} alt="" />
        <span>{props.user.id}</span>
      </button>
      {props.user.selected ? (
        <button
          className="moveButton rightMove"
          type="button"
          aria-label="Move selected user right"
          onClick={() => props.onMove("right")}
        >
          <ChevronRight size={24} />
        </button>
      ) : null}
    </div>
  );
}

function TransferArrow(props: { notice: TransferNotice }) {
  const directionClass = transferDirectionClass(props.notice);
  return (
    <div className={`transferArrow ${directionClass}`}>
      <div className="transferText">{props.notice.text}</div>
      <div className="transferLine">
        <span className="transferHead" />
      </div>
    </div>
  );
}

function transferDirectionClass(notice: TransferNotice): string {
  if (notice.from === "left" && notice.to === "right") {
    return "leftToRight";
  }
  if (notice.from === "right" && notice.to === "left") {
    return "rightToLeft";
  }
  if (notice.from === "global" && notice.to === "left") {
    return "dbToLeft";
  }
  if (notice.from === "left" && notice.to === "global") {
    return "leftToDb";
  }
  if (notice.from === "global" && notice.to === "right") {
    return "dbToRight";
  }
  if (notice.from === "right" && notice.to === "global") {
    return "rightToDb";
  }
  return "leftToRight";
}

function nearestEdge(x: number): EdgeKey {
  return x < 0.5 ? "left" : "right";
}

function currentUserX(user: UserState): number {
  if (
    user.moving === null ||
    user.movingFromX === undefined ||
    user.movingToX === undefined ||
    user.movingStartedAt === undefined
  ) {
    return user.x;
  }

  const progress = Math.min(
    1,
    Math.max(0, (Date.now() - user.movingStartedAt) / 10_000),
  );
  return user.movingFromX + (user.movingToX - user.movingFromX) * progress;
}

function edgeKeyFromEdgeId(edgeId: string): EdgeKey | null {
  if (edgeId === edgeIdByKey.left) {
    return "left";
  }
  if (edgeId === edgeIdByKey.right) {
    return "right";
  }
  return null;
}

function userId(id: UserId): string {
  return `user-${id}`;
}

function cloneEdgePanel(panel: EdgePanelState): EdgePanelState {
  return {
    1: { ...panel[1] },
    2: { ...panel[2] },
    3: { ...panel[3] },
  };
}

function mergeEdgePanelPoll(
  current: Record<EdgeKey, EdgePanelState>,
  next: Record<EdgeKey, EdgePanelState>,
): Record<EdgeKey, EdgePanelState> {
  return {
    left: mergeSingleEdgePanel(current.left, next.left),
    right: mergeSingleEdgePanel(current.right, next.right),
  };
}

function collectPersistenceNotices(
  current: Record<EdgeKey, EdgePanelState>,
  next: Record<EdgeKey, EdgePanelState>,
): Array<Omit<TransferNotice, "id">> {
  const notices: Array<Omit<TransferNotice, "id">> = [];

  (["left", "right"] as EdgeKey[]).forEach((edge) => {
    ([1, 2, 3] as UserId[]).forEach((id) => {
      const hadStm = current[edge][id].stm;
      const hasStm = next[edge][id].stm;
      if (hadStm && !hasStm) {
        notices.push({
          from: edge,
          to: "global",
          text: `memory persist user-${id}: ${edgeIdByKey[edge]} -> global memory`,
        });
      }
    });
  });

  return notices;
}

function mergeSingleEdgePanel(
  current: EdgePanelState,
  next: EdgePanelState,
): EdgePanelState {
  return {
    1: mergeUserEdgeState(current[1], next[1]),
    2: mergeUserEdgeState(current[2], next[2]),
    3: mergeUserEdgeState(current[3], next[3]),
  };
}

function mergeUserEdgeState(
  current: UserEdgeState,
  next: UserEdgeState,
): UserEdgeState {
  if (!next.stm && !next.ltmCached) {
    return next;
  }

  return {
    ...next,
    ltmExpiresAt: next.ltmExpiresAt ?? current.ltmExpiresAt,
    stmMessages:
      next.stmMessages.length > 0 ? next.stmMessages : current.stmMessages,
    ltmMemories:
      next.ltmMemories.length > 0 ? next.ltmMemories : current.ltmMemories,
  };
}
