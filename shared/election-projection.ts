/**
 * Election projection from real WarEra tallies. Model (documented in the UI):
 * votes still to come = votes so far × (remaining time / elapsed time), i.e.
 * the observed pace continues; they split by a Dirichlet draw around the
 * observed shares (+1 smoothing). A seeded Monte Carlo gives each candidate's
 * chance of finishing in the elected places. It is a projection, not a
 * forecast of voter behaviour, and it says so when there is too little data.
 */
export type ProjectionCandidate = { user: string; party: string | null; votes: number };
export type ProjectionInput = { type: string | null; electedCount: number | null; votesStartAt: string | null; votesEndAt: string | null; candidates: ProjectionCandidate[] };
export type CandidateProjection = ProjectionCandidate & { share: number; projectedVotes: number; electedProbability: number; rank: number };
export type ElectionProjection = {
  phase: 'not-started' | 'live' | 'final' | 'unknown';
  elapsedFraction: number | null; totalVotes: number; projectedTotal: number; seats: number;
  candidates: CandidateProjection[]; confidence: 'final' | 'high' | 'medium' | 'low' | 'none'; notes: string[];
};

export const SIMULATIONS = 2000;
const MIN_VOTES = 10;

// Small deterministic PRNG so the same tallies always produce the same numbers.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gamma(shape: number, random: () => number): number {
  // Marsaglia–Tsang; shape >= 1 here because of +1 smoothing.
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = random() || 1e-12, u2 = random(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function projectElection(input: ProjectionInput, now = new Date()): ElectionProjection {
  const candidates = input.candidates.filter(candidate => candidate.user).map(candidate => ({ ...candidate, votes: Math.max(0, Math.floor(candidate.votes || 0)) }));
  const seats = Math.max(1, Math.min(candidates.length || 1, input.type === 'president' ? 1 : input.electedCount ?? 1));
  const totalVotes = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  const start = Date.parse(input.votesStartAt ?? ''), end = Date.parse(input.votesEndAt ?? ''), t = now.getTime();
  const phase: ElectionProjection['phase'] = !Number.isFinite(start) || !Number.isFinite(end) ? 'unknown' : t < start ? 'not-started' : t >= end ? 'final' : 'live';
  const elapsedFraction = phase === 'live' ? (t - start) / (end - start) : phase === 'final' ? 1 : phase === 'not-started' ? 0 : null;
  const notes: string[] = [];
  const shares = candidates.map(candidate => totalVotes ? candidate.votes / totalVotes : 0);
  const ranked = candidates.map((candidate, index) => ({ ...candidate, share: shares[index] })).sort((a, b) => b.votes - a.votes || a.user.localeCompare(b.user));
  const rankOf = new Map(ranked.map((candidate, index) => [candidate.user, index + 1]));

  if (phase === 'final' || (phase === 'unknown' && totalVotes > 0)) {
    if (phase === 'unknown') notes.push('Sin fechas de votación válidas: se muestran los votos actuales sin proyectar.');
    return { phase, elapsedFraction, totalVotes, projectedTotal: totalVotes, seats, confidence: phase === 'final' ? 'final' : 'low', notes,
      candidates: ranked.map(candidate => ({ ...candidate, projectedVotes: candidate.votes, electedProbability: (rankOf.get(candidate.user) ?? 99) <= seats ? 1 : 0, rank: rankOf.get(candidate.user)! })) };
  }
  if (phase === 'not-started' || !candidates.length || totalVotes < MIN_VOTES || !elapsedFraction || elapsedFraction < 0.02) {
    notes.push(totalVotes < MIN_VOTES ? `Menos de ${MIN_VOTES} votos: no hay base suficiente para proyectar.` : 'La votación acaba de empezar o no ha empezado.');
    return { phase, elapsedFraction, totalVotes, projectedTotal: totalVotes, seats, confidence: 'none', notes,
      candidates: ranked.map(candidate => ({ ...candidate, projectedVotes: candidate.votes, electedProbability: NaN, rank: rankOf.get(candidate.user)! })) };
  }

  const remaining = Math.round(totalVotes * (1 - elapsedFraction) / elapsedFraction);
  const seed = candidates.reduce((hash, candidate) => (Math.imul(hash ^ candidate.votes, 16777619) + candidate.user.length) >>> 0, 2166136261 ^ totalVotes);
  const random = mulberry32(seed);
  const elected = new Array(candidates.length).fill(0);
  for (let simulation = 0; simulation < SIMULATIONS; simulation++) {
    const weights = candidates.map(candidate => gamma(candidate.votes + 1, random));
    const sum = weights.reduce((a, b) => a + b, 0);
    const finals = candidates.map((candidate, index) => candidate.votes + remaining * weights[index] / sum + random() * 1e-6);
    const order = finals.map((value, index) => [value, index] as const).sort((a, b) => b[0] - a[0]);
    for (let place = 0; place < seats; place++) elected[order[place][1]]++;
  }
  const probability = new Map(candidates.map((candidate, index) => [candidate.user, elected[index] / SIMULATIONS]));
  const confidence = elapsedFraction >= 0.75 ? 'high' : elapsedFraction >= 0.35 ? 'medium' : 'low';
  notes.push(`Proyección si se mantiene el ritmo observado: ${remaining} votos más hasta el cierre.`, 'Las probabilidades salen de 2.000 simulaciones alrededor de los porcentajes actuales; no anticipan campañas ni votos de última hora.');
  return { phase, elapsedFraction, totalVotes, projectedTotal: totalVotes + remaining, seats, confidence, notes,
    candidates: ranked.map(candidate => ({ ...candidate, projectedVotes: Math.round(candidate.votes + remaining * candidate.share), electedProbability: probability.get(candidate.user) ?? 0, rank: rankOf.get(candidate.user)! })) };
}
