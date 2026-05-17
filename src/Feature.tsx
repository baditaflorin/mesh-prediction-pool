import { useEffect, useState } from "react";
import {
  Leaderboard,
  useEventLog,
  useNamedPeer,
  type MeshConfig,
  type YRoom,
} from "@baditaflorin/mesh-common";

type Props = { room: YRoom | null; config: MeshConfig };
type Market = { id: string; peerId: string; question: string; ts: number };
type Bet = {
  id: string;
  marketId: string;
  peerId: string;
  side: "yes" | "no";
  amount: number;
  ts: number;
};

const START = 1000;

export function Feature({ room, config }: Props) {
  if (!room) {
    return (
      <div className="pp-screen">
        <h1>prediction pool</h1>
        <p>Connecting…</p>
      </div>
    );
  }
  return <Body room={room} config={config} />;
}

function Body({ room, config }: { room: YRoom; config: MeshConfig }) {
  const { name, setName, nameOf, myName } = useNamedPeer(config, room);
  const markets = useEventLog<Market>(room, "markets");
  const bets = useEventLog<Bet>(room, "bets");
  const [, rerender] = useState(0);
  const [question, setQuestion] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const resolutions = room.doc.getMap<"yes" | "no">("resolutions");
  const payouts = room.doc.getMap<number>("payouts");

  useEffect(() => {
    const cb = () => rerender((n) => n + 1);
    resolutions.observe(cb);
    payouts.observe(cb);
    return () => {
      resolutions.unobserve(cb);
      payouts.unobserve(cb);
    };
  }, [resolutions, payouts]);

  // Settle any newly-resolved market that lacks payouts.
  useEffect(() => {
    const all = bets.events;
    resolutions.forEach((side, mid) => {
      const tag = `${mid}|__settled`;
      if (payouts.get(tag) === 1) return;
      const onMarket = all.filter((b) => b.marketId === mid);
      const winners = onMarket.filter((b) => b.side === side);
      const losers = onMarket.filter((b) => b.side !== side);
      const pool = losers.reduce((s, b) => s + b.amount, 0);
      const wTotal = winners.reduce((s, b) => s + b.amount, 0);
      room.doc.transact(() => {
        for (const w of winners) {
          const share = wTotal > 0 ? w.amount + (w.amount / wTotal) * pool : w.amount;
          const k = `${mid}|${w.peerId}`;
          payouts.set(k, (payouts.get(k) ?? 0) + share);
        }
        payouts.set(tag, 1);
      });
    });
  }, [bets.size, resolutions, payouts, room.doc, bets.events]);

  const balanceOf = (pid: string) => {
    let b = START;
    for (const x of bets.events) if (x.peerId === pid) b -= x.amount;
    payouts.forEach((v, k) => {
      const [, who] = k.split("|");
      if (who === pid) b += v;
    });
    return b;
  };
  const myBalance = balanceOf(room.peerId);

  const openMarket = () => {
    const q = question.trim();
    if (!q || !name.trim()) return;
    markets.push({
      id: Math.random().toString(36).slice(2, 10),
      peerId: room.peerId,
      question: q,
      ts: Date.now(),
    });
    setQuestion("");
  };

  const placeBet = (mid: string, side: "yes" | "no") => {
    const amt = Math.floor(Number(amounts[mid] ?? "0"));
    if (!amt || amt <= 0 || amt > myBalance) return;
    bets.push({
      id: Math.random().toString(36).slice(2, 10),
      marketId: mid,
      peerId: room.peerId,
      side,
      amount: amt,
      ts: Date.now(),
    });
    setAmounts((m) => ({ ...m, [mid]: "" }));
  };

  const peerIds = new Set<string>([room.peerId]);
  markets.events.forEach((m) => peerIds.add(m.peerId));
  bets.events.forEach((b) => peerIds.add(b.peerId));
  const leaderboard = Array.from(peerIds)
    .map((pid) => ({
      id: pid,
      name: nameOf(pid) ?? (pid === room.peerId ? myName : `peer-${pid.slice(0, 6)}`),
      score: balanceOf(pid),
      isMe: pid === room.peerId,
    }))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="pp-screen">
      <h1>prediction pool</h1>
      <div className="pp-balance">your balance: {myBalance}</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="your name"
        aria-label="your name"
        maxLength={48}
      />
      <div className="pp-create">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="question"
          maxLength={140}
        />
        <button
          type="button"
          className="pp-open"
          aria-label="open market"
          onClick={openMarket}
          disabled={!question.trim() || !name.trim()}
        >
          open market
        </button>
      </div>
      <div className="pp-markets">
        {markets.events.map((m) => {
          const mb = bets.events.filter((b) => b.marketId === m.id);
          const yesT = mb.filter((b) => b.side === "yes").reduce((s, b) => s + b.amount, 0);
          const noT = mb.filter((b) => b.side === "no").reduce((s, b) => s + b.amount, 0);
          const resolved = resolutions.get(m.id);
          const amt = Math.floor(Number(amounts[m.id] ?? "0"));
          const canBet = !resolved && amt > 0 && amt <= myBalance;
          const myStake = mb
            .filter((b) => b.peerId === room.peerId)
            .reduce((s, b) => s + b.amount, 0);
          const myPay = payouts.get(`${m.id}|${room.peerId}`) ?? 0;
          return (
            <div key={m.id} className="pp-market" data-market-id={m.id}>
              <div className="pp-q">{m.question}</div>
              <div className="pp-author">
                by {nameOf(m.peerId) ?? `peer-${m.peerId.slice(0, 6)}`}
              </div>
              {!resolved && (
                <>
                  <div className="pp-totals">
                    yes: {yesT} · no: {noT}
                  </div>
                  <div className="pp-betrow">
                    <input
                      type="number"
                      placeholder="bet amount"
                      value={amounts[m.id] ?? ""}
                      onChange={(e) => setAmounts((s) => ({ ...s, [m.id]: e.target.value }))}
                      min={1}
                    />
                    <button type="button" onClick={() => placeBet(m.id, "yes")} disabled={!canBet}>
                      bet yes
                    </button>
                    <button type="button" onClick={() => placeBet(m.id, "no")} disabled={!canBet}>
                      bet no
                    </button>
                  </div>
                  {m.peerId === room.peerId && (
                    <div className="pp-resolve">
                      <button type="button" onClick={() => resolutions.set(m.id, "yes")}>
                        resolve YES
                      </button>
                      <button type="button" onClick={() => resolutions.set(m.id, "no")}>
                        resolve NO
                      </button>
                    </div>
                  )}
                </>
              )}
              {resolved && (
                <div className="pp-resolved">
                  <span className="pp-chip">{resolved.toUpperCase()}</span>
                  <span>your stake: {myStake}</span>
                  <span>your payout: {Math.floor(myPay)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Leaderboard
        items={leaderboard}
        title="balances"
        formatScore={(s) => String(Math.floor(s))}
      />
    </div>
  );
}
