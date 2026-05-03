import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, SendHorizontal } from "lucide-react";
import { Toaster, toast } from "sonner";

import edgeServerAsset from "./assets/edge-server.png";
import userAsset from "./assets/user.png";
import {
  EdgeKey,
  GenerateResponse,
  HealthResponse,
  exportHandoverPackage,
  fetchEdgeHealth,
  generate,
  importHandoverPackage,
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
  ltmCount: number;
  lastSeen?: string;
};

type EdgePanelState = Record<UserId, UserEdgeState>;

type TransferNotice = {
  id: number;
  from: EdgeKey;
  to: EdgeKey;
  text: string;
};

const usersInitial: UserState[] = [
  { id: 1, x: 0.24, selected: true, moving: null, requestCount: 0, active: false, lastCachePhase: "idle" },
  { id: 2, x: 0.24, selected: false, moving: null, requestCount: 0, active: false, lastCachePhase: "idle" },
  { id: 3, x: 0.24, selected: false, moving: null, requestCount: 0, active: false, lastCachePhase: "idle" },
];

const emptyEdgePanel: EdgePanelState = {
  1: { stm: false, ltmCount: 0 },
  2: { stm: false, ltmCount: 0 },
  3: { stm: false, ltmCount: 0 },
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
  const [transferNotice, setTransferNotice] = useState<TransferNotice | null>(null);

  const selectedUser = useMemo(
    () => users.find((user) => user.selected) ?? users[0],
    [users],
  );

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const [left, right] = await Promise.allSettled([
        fetchEdgeHealth("left"),
        fetchEdgeHealth("right"),
      ]);

      if (!cancelled) {
        setHealth({
          left: left.status === "fulfilled" ? left.value : null,
          right: right.status === "fulfilled" ? right.value : null,
        });
      }

      const knownUsers = users.filter((user) => user.sessionId);
      const nextPanel: Record<EdgeKey, EdgePanelState> = {
        left: cloneEdgePanel(emptyEdgePanel),
        right: cloneEdgePanel(emptyEdgePanel),
      };

      await Promise.all(
        knownUsers.flatMap((user) =>
          (["left", "right"] as EdgeKey[]).map(async (edge) => {
            try {
              const exported = await exportHandoverPackage(edge, {
                userId: userId(user.id),
                sessionId: user.sessionId!,
                targetEdgeId: oppositeEdgeId[edge],
              });
              const pkg = exported.package;
              nextPanel[edge][user.id] = {
                stm: pkg.stm !== null,
                ltmCount: pkg.ltm.length,
                lastSeen: new Date().toLocaleTimeString(),
              };
            } catch {
              nextPanel[edge][user.id] = {
                stm: false,
                ltmCount: 0,
              };
            }
          }),
        ),
      );

      if (!cancelled) {
        setEdgePanel(nextPanel);
      }
    }

    poll();
    const interval = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [users]);

  useEffect(() => {
    const ttlSeconds = Math.min(
      health.left?.stm?.activeSessions !== undefined
        ? health.left.localSessionRegistry?.ttlSeconds ?? Number.POSITIVE_INFINITY
        : Number.POSITIVE_INFINITY,
      health.right?.stm?.activeSessions !== undefined
        ? health.right.localSessionRegistry?.ttlSeconds ?? Number.POSITIVE_INFINITY
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

  async function triggerPretransfer(user: UserState, source: EdgeKey, target: EdgeKey) {
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
          ? { ...user, active: true, lastCachePhase: cachePhase, lastEdge: edge }
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
      showTransferNoticeFromResponse(selectedUser.id, edge, response);
      setMessage("");
      toast.success(`Answer for user${selectedUser.id}: ${response.output || "(empty)"}`);
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

  function showTransferNoticeFromResponse(id: UserId, requestEdge: EdgeKey, response: GenerateResponse) {
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
      setTransferNotice((current) => (current?.id === noticeId ? null : current));
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

    const sourceEdge = response.metrics.edgeNodeId === "edge-node-right" ? "right" : edge;
    setEdgePanel((current) => ({
      ...current,
      [sourceEdge]: {
        ...current[sourceEdge],
        [id]: {
          stm: true,
          ltmCount: response.metrics.memorySource === "cache" ? Math.max(current[sourceEdge][id].ltmCount, 1) : 1,
          lastSeen: new Date().toLocaleTimeString(),
        },
      },
    }));
  }

  return (
    <main className="dashboardShell">
      <Toaster richColors position="bottom-right" />
      <section className="topology" aria-label="Edge topology">
        <EdgeNode
          edge="left"
          label="1"
          health={health.left}
          panel={edgePanel.left}
          users={users}
        />
        <EdgeNode
          edge="right"
          label="2"
          health={health.right}
          panel={edgePanel.right}
          users={users}
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
        <button type="submit" aria-label="Send message" disabled={!message.trim() || selectedUser.active}>
          {selectedUser.active ? <Loader2 className="spinIcon" size={24} /> : <SendHorizontal size={24} />}
        </button>
      </form>
    </main>
  );
}

function EdgeNode(props: {
  edge: EdgeKey;
  label: string;
  health: HealthResponse | null;
  panel: EdgePanelState;
  users: UserState[];
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
          <span className={online ? "statusOnline" : "statusOffline"}>{online ? "online" : "offline"}</span>
          <span>{props.health?.edgeNodeId ?? edgeIdByKey[props.edge]}</span>
        </div>
        <div className="edgeMetrics">
          <Metric label="active sessions" value={props.health?.stm?.activeSessions ?? 0} />
          <Metric label="ltm cache" value={props.health?.ltmCache?.entryCount ?? 0} />
          <Metric label="local registry" value={props.health?.localSessionRegistry?.entryCount ?? 0} />
        </div>
        <div className="userStateList">
          {props.users.map((user) => {
            const state = props.panel[user.id];
            return (
              <div className="userStateRow" key={user.id}>
                <div className="userStateName">
                  {user.active && user.lastEdge === props.edge ? <Loader2 className="spinIcon" size={15} /> : null}
                  <span>User {user.id}</span>
                </div>
                <span>{user.lastCachePhase}</span>
                <span>STM {state.stm ? "yes" : "no"}</span>
                <span>LTM {state.ltmCount}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
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

function UserMarker(props: {
  user: UserState;
  index: number;
  onSelect: () => void;
  onMove: (direction: "left" | "right") => void;
}) {
  const top = 62 + props.index * 10.5;
  return (
    <div
      className={`userMarker ${props.user.selected ? "selected" : ""} ${props.user.moving ? "moving" : ""}`}
      style={{
        left: `${props.user.x * 100}%`,
        top: `${top}%`,
        "--user-color": userColors[props.user.id],
      } as CSSProperties}
    >
      {props.user.selected ? (
        <button className="moveButton leftMove" type="button" aria-label="Move selected user left" onClick={() => props.onMove("left")}>
          <ChevronLeft size={24} />
        </button>
      ) : null}
      <button className="userButton" type="button" aria-label={`Select user ${props.user.id}`} onClick={props.onSelect}>
        <img src={userAsset} alt="" />
        <span>{props.user.id}</span>
      </button>
      {props.user.selected ? (
        <button className="moveButton rightMove" type="button" aria-label="Move selected user right" onClick={() => props.onMove("right")}>
          <ChevronRight size={24} />
        </button>
      ) : null}
    </div>
  );
}

function TransferArrow(props: { notice: TransferNotice }) {
  const leftToRight = props.notice.from === "left" && props.notice.to === "right";
  return (
    <div className={`transferArrow ${leftToRight ? "leftToRight" : "rightToLeft"}`}>
      <div className="transferText">{props.notice.text}</div>
      <div className="transferLine">
        <span className="transferHead" />
      </div>
    </div>
  );
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

  const progress = Math.min(1, Math.max(0, (Date.now() - user.movingStartedAt) / 10_000));
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
