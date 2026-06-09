import {
  CSSProperties,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  SendHorizontal,
  Settings,
  User,
} from "lucide-react";
import { Toaster, toast } from "sonner";

import edgeServerAsset from "./assets/edge-server.png";
import userAsset from "./assets/user.png";
import dbAsset from "./assets/db.avif";
import {
  EdgeKey,
  GenerateResponse,
  GlobalMemoryEntry,
  HealthResponse,
  exportHandoverPackage,
  fetchEdgeHealth,
  fetchEdgeUserState,
  fetchGlobalMemories,
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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  edge: EdgeKey;
};

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

function calcBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

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
  const [sideSheetOpen, setSideSheetOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    cacheTtlSeconds: 120,
  });
  const [chatHistory, setChatHistory] = useState<Record<UserId, ChatMessage[]>>(
    {
      1: [],
      2: [],
      3: [],
    },
  );

  const prevEdgePanelRef = useRef<Record<EdgeKey, EdgePanelState>>({
    left: emptyEdgePanel,
    right: emptyEdgePanel,
  });

  // Detect STM expiry transitions and show an immediate "persisting…" notice.
  // The final result notice arrives via SSE once embedding completes.
  useEffect(() => {
    (["left", "right"] as EdgeKey[]).forEach((edge) => {
      ([1, 2, 3] as UserId[]).forEach((id) => {
        if (
          prevEdgePanelRef.current[edge][id].stm &&
          !edgePanel[edge][id].stm
        ) {
          showTransferNotice({
            from: edge,
            to: "global",
            text: `memory persist user-${id}: ${edgeIdByKey[edge]} → global DB (persisting…)`,
          });
        }
      });
    });
    prevEdgePanelRef.current = edgePanel;
  }, [edgePanel]);

  // Subscribe to SSE streams from both edge nodes (mount-once).
  useEffect(() => {
    const sources = (["left", "right"] as EdgeKey[]).map((edge) => {
      const source = new EventSource(`/api/${edge}/events`);
      source.onmessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data as string) as {
            type?: string;
            userId?: string;
            stored?: number;
          };
          if (data.type === "persistence_completed" && data.userId) {
            const stored = data.stored ?? 0;
            showTransferNotice({
              from: edge,
              to: "global",
              text:
                stored > 0
                  ? `memory persist ${data.userId}: ${edgeIdByKey[edge]} → global DB, ${stored} memor${stored === 1 ? "y" : "ies"} stored`
                  : `memory persist ${data.userId}: no new memories stored`,
            });
          } else if (data.type === "persistence_failed" && data.userId) {
            showTransferNotice({
              from: edge,
              to: "global",
              text: `memory persist ${data.userId}: persistence failed on ${edgeIdByKey[edge]}`,
            });
          }
        } catch {
          // ignore malformed frames
        }
      };
      return source;
    });
    return () => sources.forEach((s) => s.close());
  }, []);

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
        setEdgePanel((current) => mergeEdgePanelPoll(current, nextPanel));
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
      const stmMsgs = exported.package.stm?.messages ?? [];
      const stmPkgSize =
        stmMsgs.length > 0 ? fmtBytes(calcBytes(stmMsgs)) : "0 B";
      const ltmPkgSize = fmtBytes(calcBytes(exported.package.ltm));
      showTransferNotice({
        from: source,
        to: target,
        text: `pretransfer user-${user.id}: ${edgeIdByKey[source]} → ${edgeIdByKey[target]}, STM ${stmPkgSize}, LTM ${ltmPkgSize}`,
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
        cacheTtlSeconds: settings.sessionTtlSeconds,
      });
    } catch {
      setSettingsForm({
        cacheTtlSeconds:
          health.left?.localSessionRegistry?.ttlSeconds ??
          health.right?.localSessionRegistry?.ttlSeconds ??
          120,
      });
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const ttl = Math.max(1, Math.floor(settingsForm.cacheTtlSeconds));
    const nextSettings = {
      sessionTtlSeconds: ttl,
      ltmCacheTtlSeconds: ttl,
    };

    setSettingsSaving(true);
    try {
      await Promise.all(
        (["left", "right"] as EdgeKey[]).map((edge) =>
          updateRuntimeSettings(edge, nextSettings),
        ),
      );
      setSettingsForm({ cacheTtlSeconds: ttl });
      setSettingsDialogOpen(false);
      toast.success(`Cache TTL applied: ${ttl}s`);
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

      updateUserAfterResponse(
        selectedUser.id,
        edge,
        cachePhase,
        response,
        trimmed,
      );
      showMemoryFetchNotice(selectedUser.id, edge, response);
      showTransferNoticeFromResponse(selectedUser.id, edge, response);
      const ts = new Date().toISOString();
      setChatHistory((current) => ({
        ...current,
        [selectedUser.id]: [
          ...current[selectedUser.id],
          { role: "user", content: trimmed, timestamp: ts, edge },
          { role: "assistant", content: response.output, timestamp: ts, edge },
        ],
      }));
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
        const src = edgePanel[requestEdge][id];
        const stmSize = proactive.stmIncluded
          ? fmtBytes(calcBytes(src.stmMessages))
          : "0 B";
        const ltmSize = fmtBytes(calcBytes(src.ltmMemories));
        showTransferNotice({
          from: requestEdge,
          to: target,
          text: `pretransfer user-${id}: ${edgeIdByKey[requestEdge]} → ${proactive.targetEdgeId}, STM ${stmSize}, LTM ${ltmSize}`,
        });
      }
    }

    const recovery = response.metrics.neighborRecovery;
    if (recovery?.attempted && recovery.recovered && recovery.sourceEdgeId) {
      const source = edgeKeyFromEdgeId(recovery.sourceEdgeId);
      if (source) {
        const stmSize = recovery.stmImported
          ? fmtBytes(calcBytes(edgePanel[requestEdge][id].stmMessages))
          : "0 B";
        const ltmSize = fmtBytes(
          calcBytes(edgePanel[requestEdge][id].ltmMemories),
        );
        showTransferNotice({
          from: source,
          to: requestEdge,
          text: `nearby fetch user-${id}: ${recovery.sourceEdgeId} → ${edgeIdByKey[requestEdge]}, STM ${stmSize}, LTM ${ltmSize}`,
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
    prompt: string,
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
    setEdgePanel((current) => {
      const prev = current[sourceEdge][id];
      return {
        ...current,
        [sourceEdge]: {
          ...current[sourceEdge],
          [id]: {
            stm: true,
            ltmCached: true,
            ltmCount: prev.ltmCount,
            cachePhase,
            stmExpiresAt: Date.now() + getSessionTtlMs(sourceEdge),
            ltmExpiresAt: Date.now() + getLtmTtlMs(sourceEdge),
            stmMessages: [
              ...prev.stmMessages,
              { role: "user", content: prompt },
              { role: "assistant", content: response.output },
            ],
            ltmMemories: prev.ltmMemories,
            lastSeen: new Date().toLocaleTimeString(),
          },
        },
      };
    });
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

      <button
        type="button"
        className="settingsTrigger"
        aria-label="Open runtime settings"
        onClick={openSettingsDialog}
      >
        <Settings size={20} />
        <span>Settings</span>
      </button>

      <button
        type="button"
        className="memoryDetailsTrigger"
        aria-label="Open user memory details"
        onClick={() => setSideSheetOpen(true)}
      >
        <User size={20} />
        <span>User {selectedUser.id}</span>
      </button>

      {sideSheetOpen ? (
        <UserSideSheet
          user={selectedUser}
          chatHistory={chatHistory[selectedUser.id]}
          onClose={() => setSideSheetOpen(false)}
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
  const [expandedUser, setExpandedUser] = useState<UserId | null>(null);
  const online = props.health?.ok === true;

  return (
    <section className={`edgeNode ${props.edge}`}>
      <div className="edgeHeader">
        <span>Edge Node {props.label}</span>
        <img src={edgeServerAsset} alt="" />
      </div>
      <div className="edgeStatePanel">
        <div className="edgeMeta">
          <span className={online ? "statusOnline" : "statusOffline"}>
            {online ? "online" : "offline"}
          </span>
          <span>{props.health?.edgeNodeId ?? edgeIdByKey[props.edge]}</span>
        </div>
        {/* <div className="edgeMetrics">
          <Metric
            label="active sessions"
            value={props.health?.stm?.activeSessions ?? 0}
          />
          <Metric
            label="ltm cache"
            value={props.health?.ltmCache?.entryCount ?? 0}
          />
        </div> */}
        <div className="userStateList">
          {props.users.map((user) => {
            const state = props.panel[user.id];
            const stmActive = isTimerActive(
              state.stm,
              state.stmExpiresAt,
              props.nowMs,
            );
            const ltmActive = isTimerActive(
              state.ltmCached,
              state.ltmExpiresAt,
              props.nowMs,
            );
            const visibleCachePhase =
              stmActive || ltmActive ? state.cachePhase : "idle";
            const isExpanded = expandedUser === user.id;

            return (
              <div
                key={user.id}
                className={`userStateRow${isExpanded ? " userStateRow--open" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setExpandedUser(isExpanded ? null : user.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    setExpandedUser(isExpanded ? null : user.id);
                }}
              >
                <div className="userStateRowInner">
                  <div className="userStateName">
                    {user.active && user.lastEdge === props.edge ? (
                      <Loader2 className="spinIcon" size={15} />
                    ) : null}
                    <span>User {user.id}</span>
                    <ChevronDown
                      size={12}
                      className={`expandChevron${isExpanded ? " expandChevron--open" : ""}`}
                    />
                  </div>
                  <span>{visibleCachePhase}</span>
                  <TimerCell
                    label="cache"
                    active={stmActive || ltmActive}
                    expiresAt={stmActive ? state.stmExpiresAt : state.ltmExpiresAt}
                    ttlSeconds={props.health?.localSessionRegistry?.ttlSeconds}
                    nowMs={props.nowMs}
                  />
                </div>

                {isExpanded && (
                  <div className="userStateExpanded">
                    <div className="userStateExpSection">
                      <span className="userStateExpLabel">STM</span>
                      {state.stmMessages.length > 0 ? (
                        <div className="userStateExpMessages">
                          {state.stmMessages.map((msg, i) => (
                            <div
                              key={i}
                              className={`userStateExpMsg userStateExpMsg--${msg.role}`}
                            >
                              <span className="userStateExpRole">
                                {msg.role}
                              </span>
                              <p>{msg.content}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="userStateExpEmpty">
                          No session on this edge.
                        </p>
                      )}
                    </div>

                    <div className="userStateExpSection">
                      <span className="userStateExpLabel">LTM cache</span>
                      {state.ltmMemories.length > 0 ? (
                        <div className="userStateExpMems">
                          {state.ltmMemories
                            .filter((mem) => !/:\s*unknown\s*$/i.test(mem))
                            .map((mem, i) => (
                              <div key={i} className="userStateExpMemItem">
                                <p>{mem}</p>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <p className="userStateExpEmpty">
                          No LTM cache on this edge.
                        </p>
                      )}
                    </div>
                  </div>
                )}
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
  size?: string | null;
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
      <span className="timerCellTop">
        <span>{props.label}</span>
        <span
          className="timerRing"
          style={{ "--progress": `${progress * 360}deg` } as CSSProperties}
        >
          {remainingSeconds}
        </span>
      </span>
      {props.size != null && <span className="timerSize">{props.size}</span>}
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

type SheetEdge = {
  stm: boolean;
  ltmCached: boolean;
  stmMessages: Array<{ role: string; content: string }>;
  ltmMemories: string[];
};

const emptySheetEdge: SheetEdge = {
  stm: false,
  ltmCached: false,
  stmMessages: [],
  ltmMemories: [],
};

function UserSideSheet(props: {
  user: UserState;
  chatHistory: ChatMessage[];
  onClose: () => void;
}) {
  const [edges, setEdges] = useState<Record<EdgeKey, SheetEdge>>({
    left: emptySheetEdge,
    right: emptySheetEdge,
  });
  const [globalMemories, setGlobalMemories] = useState<GlobalMemoryEntry[]>([]);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const uid = userId(props.user.id);
      const sid = props.user.sessionId;

      const [leftRes, rightRes, globalRes] = await Promise.allSettled([
        fetchEdgeUserState("left", { userId: uid, sessionId: sid }),
        fetchEdgeUserState("right", { userId: uid, sessionId: sid }),
        fetchGlobalMemories(uid),
      ]);

      if (cancelled) return;

      const mapEdge = (res: typeof leftRes): SheetEdge => {
        if (res.status !== "fulfilled") return emptySheetEdge;
        const s = res.value;
        return {
          stm: s.stm !== null,
          ltmCached: s.ltm.present,
          stmMessages: s.stm?.messages ?? [],
          ltmMemories: s.ltm.memories,
        };
      };

      setEdges({ left: mapEdge(leftRes), right: mapEdge(rightRes) });

      if (globalRes.status === "fulfilled") {
        setGlobalMemories(globalRes.value);
        setGlobalError(null);
      } else {
        setGlobalError(
          globalRes.reason instanceof Error
            ? globalRes.reason.message
            : String(globalRes.reason),
        );
      }
      setGlobalLoading(false);
    }

    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [props.user.id, props.user.sessionId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <>
      <div
        className="sideSheetBackdrop"
        role="presentation"
        onClick={props.onClose}
      />
      <aside
        className="sideSheet"
        role="complementary"
        aria-label={`Memory details for user ${props.user.id}`}
        ref={sheetRef}
      >
        <div className="sideSheetHeader">
          <div>
            <strong>User {props.user.id}</strong>
            <span>
              {props.user.sessionId
                ? `session ${props.user.sessionId.slice(0, 8)}…`
                : "no active session"}
            </span>
          </div>
          <button type="button" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="sideSheetBody">
          <div className="sideSheetSection sideSheetLocalHistory">
            <div className="sideSheetSectionHead">
              <span>Chat history</span>
              <span className="ssSubtitle">
                local · {Math.floor(props.chatHistory.length / 2)} turns
              </span>
            </div>
            {props.chatHistory.length === 0 ? (
              <p className="ssEmpty">No messages yet.</p>
            ) : (
              <div className="ssChatHistory">
                {props.chatHistory.map((msg, i) => (
                  <div key={i} className={`ssChatMsg ssChatMsg--${msg.role}`}>
                    <div className="ssChatMsgMeta">
                      <span className="ssChatRole">{msg.role}</span>
                      <span className="ssChatEdge">
                        {edgeIdByKey[msg.edge]}
                      </span>
                      <span className="ssChatTime">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p>{msg.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sideSheetEdgeGrid">
            {(["left", "right"] as EdgeKey[]).map((edge) => {
              const state = edges[edge];
              const stmSize =
                state.stmMessages.length > 0
                  ? fmtBytes(calcBytes(state.stmMessages))
                  : null;
              const ltmSize =
                state.ltmMemories.length > 0
                  ? fmtBytes(calcBytes(state.ltmMemories))
                  : null;
              return (
                <div className="sideSheetEdgeCol" key={edge}>
                  <h3 className="sideSheetEdgeTitle">{edgeIdByKey[edge]}</h3>

                  <div className="sideSheetSection">
                    <div className="sideSheetSectionHead">
                      <span>STM</span>
                      {stmSize != null && (
                        <span className="ssSize">{stmSize}</span>
                      )}
                    </div>
                    {state.stmMessages.length > 0 ? (
                      <div className="ssChatHistory">
                        {state.stmMessages.map((msg, i) => (
                          <div
                            key={`${edge}-stm-${i}`}
                            className={`ssChatMsg ssChatMsg--${msg.role}`}
                          >
                            <span className="ssChatRole">{msg.role}</span>
                            <p>{msg.content}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="ssEmpty">No session on this edge.</p>
                    )}
                  </div>

                  <div className="sideSheetSection">
                    <div className="sideSheetSectionHead">
                      <span>LTM cache</span>
                      {ltmSize != null && (
                        <span className="ssSize">{ltmSize}</span>
                      )}
                    </div>
                    {state.ltmMemories.length > 0 ? (
                      <div className="ssMemList">
                        {state.ltmMemories
                          .filter((mem) => !/:\s*unknown\s*$/i.test(mem))
                          .map((mem, i) => (
                            <div key={`${edge}-ltm-${i}`} className="ssMemItem">
                              <p>{mem}</p>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <p className="ssEmpty">No LTM cache on this edge.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sideSheetGlobal">
            <div className="sideSheetSectionHead sideSheetSectionHead--global">
              <span>Global LTM</span>
              {!globalLoading && !globalError && (
                <span className="ssSize">
                  {fmtBytes(calcBytes(globalMemories))}
                </span>
              )}
            </div>
            {globalLoading ? (
              <p className="ssEmpty ssEmpty--loading">
                <Loader2 className="spinIcon" size={13} /> Fetching…
              </p>
            ) : globalError ? (
              <p className="ssEmpty ssEmpty--error">{globalError}</p>
            ) : globalMemories.length > 0 ? (
              <div className="ssMemList">
                {globalMemories.map((entry, i) => (
                  <div key={entry.id ?? i} className="ssMemItem">
                    <p>{entry.memory}</p>
                    {entry.updated_at && (
                      <span className="ssMemMeta">
                        {new Date(entry.updated_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="ssEmpty">No memories in global store.</p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function SettingsDialog(props: {
  values: { cacheTtlSeconds: number };
  saving: boolean;
  onChange: (values: { cacheTtlSeconds: number }) => void;
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
          <span>Cache TTL (seconds)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={props.values.cacheTtlSeconds}
            onChange={(event) =>
              props.onChange({ cacheTtlSeconds: Number(event.target.value) })
            }
          />
        </label>

        <button
          className="settingsSubmit"
          type="submit"
          disabled={props.saving || props.values.cacheTtlSeconds < 1}
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
      <img src={dbAsset} style={{ width: "9rem" }} />
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
    // Only carry forward cached messages/memories while the owning flag is still
    // active. If stm/ltmCached flipped to false the data must be cleared even
    // though the array happens to be empty in `next`.
    stmMessages:
      next.stm && next.stmMessages.length === 0
        ? current.stmMessages
        : next.stmMessages,
    ltmMemories:
      next.ltmCached && next.ltmMemories.length === 0
        ? current.ltmMemories
        : next.ltmMemories,
  };
}
