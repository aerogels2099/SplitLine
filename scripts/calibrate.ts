import {
  eloPredictions,
  favouriteSide,
  fitEloDivisor,
  fitBandCaps,
  fitScenarioWeights,
  inRunPredictions,
  inRunReliability,
  pregamePredictions,
  ratedGames,
  reliability,
  scenarioCases,
  scenarioPredictions,
  tailsByBand,
  score,
  temporalCutoff,
  type BandedCall,
  type BandTail,
  type InRunObservation,
  type MatchBin,
  type ReliabilityBin,
  type Scores,
} from "../src/analysis/calibration.js";
import { H2H_SEASONS, SCENARIO_WEIGHTS } from "../src/analysis/matchup.js";
import { extractAllRuns, MILESTONES } from "../src/analysis/splits.js";
import { ELO_DIVISOR } from "../src/analysis/stats.js";
import { buildBandedWinProbModels } from "../src/analysis/winprob.js";
import { Store } from "../src/db/db.js";

const TRAIN_SHARE = 0.7;
const DIVISORS = Array.from({ length: 201 }, (_, i) => 200 + i * 5);
const ELAPSED_BUCKETS_MIN = [0, 2, 4, 6, 8, 10, Infinity];
const MIN_TAIL_MATCHES = 30;
const CAP_GRID = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4];
const SCENARIO_WEIGHT_GRID = Array.from({ length: 31 }, (_, i) => i / 20);

const store = new Store(process.argv[2] ?? "data/splitline.db");

const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;
const line = (s: Scores) =>
  `n=${String(s.n).padStart(6)}  logloss ${s.logLoss.toFixed(4)}  brier ${s.brier.toFixed(4)}  ece ${s.ece.toFixed(4)}`;
const byBand = (calls: BandedCall[]): BandTail[] => {
  const tails = tailsByBand(calls, 0.8, MIN_TAIL_MATCHES);
  console.log(`   favourite at 80%+, by band of the pair's average rating:`);
  for (const t of tails) {
    const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
    console.log(
      `     ${t.band.padEnd(12)} matches=${String(t.matches).padStart(4)}  predicted ${pct(t.predicted)}  won ${pct(t.observed)}  ${signed(t.observed - t.predicted).padStart(6)} pts [${signed(t.low)}, ${signed(t.high)}]  ${t.verdict}`,
    );
  }
  return tails;
};
const bandsWhere = (tails: BandTail[], ...verdicts: BandTail["verdict"][]) =>
  tails.filter((t) => verdicts.includes(t.verdict)).map((t) => t.band);
const offBands = (tails: BandTail[]) => bandsWhere(tails, "overconfident", "underconfident");

const curve = (bins: (ReliabilityBin & Partial<MatchBin>)[]) =>
  bins
    .map(
      (b) =>
        `     ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  n=${String(b.n).padStart(6)}${b.matches === undefined ? "" : `  matches=${String(b.matches).padStart(4)}`}  predicted ${pct(b.predicted)}  observed ${pct(b.observed)}`,
    )
    .join("\n");

const ranked = store.getMatches({ type: 2 });
const cutA = temporalCutoff(
  ranked.map((m) => m.date),
  TRAIN_SHARE,
);
const trainA = ranked.filter((m) => m.date < cutA);
const testA = ranked.filter((m) => m.date >= cutA);
const trainGames = ratedGames(trainA);
const testGames = ratedGames(testA);
const fitted = fitEloDivisor(trainGames, DIVISORS);

console.log(`A. Elo prior  ${trainGames.length} train games before ${day(cutA)}, ${testGames.length} test after`);
console.log(`   divisor fitted on train: ${fitted}`);
const eloScores = new Map<number, Scores>();
for (const d of [...new Set([400, ELO_DIVISOR, fitted])]) {
  eloScores.set(d, score(eloPredictions(testGames, d)));
  console.log(`   test  d=${String(d).padEnd(4)} ${line(eloScores.get(d)!)}`);
}
console.log(`   divisor fitted per season:`);
for (const season of [...new Set(ranked.map((m) => m.season))].sort((a, b) => a - b)) {
  const games = ratedGames(ranked.filter((m) => m.season === season));
  if (games.length > 0) {
    console.log(`     S${season}  n=${String(games.length).padStart(5)}  d=${fitEloDivisor(games, DIVISORS)}`);
  }
}
console.log(`   reliability on test from the favourite's side, d=${fitted}:`);
console.log(curve(reliability(eloPredictions(testGames, fitted).map(favouriteSide))));

const pre = pregamePredictions(trainA, testA);
const preScores = { elo: score(pre.elo), base: score(pre.base) };
const h2hGain = preScores.base.logLoss - preScores.elo.logLoss;
console.log(
  `\nB. Pre-match prediction on the same test games (d=${ELO_DIVISOR}, head-to-head over ${H2H_SEASONS} seasons)`,
);
console.log(`   elo only       ${line(preScores.elo)}`);
console.log(
  `   + head-to-head ${line(preScores.base)}   ${h2hGain <= 0 ? "" : "+"}${h2hGain.toFixed(4)} vs elo only`,
);

const details = store.getDetails();
const cutC = temporalCutoff(
  details.map((d) => d.date),
  TRAIN_SHARE,
);
const trainDetails = details.filter((d) => d.date < cutC);
const testDetails = details.filter((d) => d.date >= cutC);
const banded = buildBandedWinProbModels(extractAllRuns(trainDetails));
const obs = inRunPredictions(banded, testDetails);
const matchesSeen = new Set(obs.map((o) => o.matchId)).size;

console.log(
  `\nC. In-run model  trained on ${trainDetails.length} matches before ${day(cutC)}, tested on ${matchesSeen} after`,
);
const inRun = { model: score(obs.map((o) => o.model)), elo: score(obs.map((o) => o.elo)) };
console.log(`   model  ${line(inRun.model)}`);
console.log(`   elo    ${line(inRun.elo)}`);
console.log(`   by elapsed time            model logloss   elo logloss`);
const byBucket: { label: string; model: number; elo: number }[] = [];
for (let i = 0; i + 1 < ELAPSED_BUCKETS_MIN.length; i++) {
  const lo = ELAPSED_BUCKETS_MIN[i]!;
  const hi = ELAPSED_BUCKETS_MIN[i + 1]!;
  const inBucket = obs.filter((o: InRunObservation) => o.elapsedMs >= lo * 60_000 && o.elapsedMs < hi * 60_000);
  if (inBucket.length === 0) continue;
  const label = hi === Infinity ? `${lo}+ min` : `${lo}–${hi} min`;
  const m = score(inBucket.map((o) => o.model)).logLoss;
  const e = score(inBucket.map((o) => o.elo)).logLoss;
  byBucket.push({ label, model: m, elo: e });
  console.log(`     ${label.padEnd(9)} n=${String(inBucket.length).padStart(5)}      ${m.toFixed(4)}         ${e.toFixed(4)}`);
}
const calibrationC = inRunReliability(obs);
console.log(`   reliability from the favourite's side, model:`);
console.log(curve(calibrationC));
const tailsC = byBand(obs.map((o) => ({ band: o.band, matchId: o.matchId, ...o.model })));

const innerCut = temporalCutoff(
  trainDetails.map((d) => d.date),
  TRAIN_SHARE,
);
const refit = fitScenarioWeights(
  scenarioCases(
    buildBandedWinProbModels(extractAllRuns(trainDetails.filter((d) => d.date < innerCut))),
    trainDetails.filter((d) => d.date >= innerCut),
  ),
  SCENARIO_WEIGHT_GRID,
);
const cases = scenarioCases(banded, testDetails);
console.log(`\nD. Split scenarios, opponent unseen, on the same test matches as C`);
console.log(`   milestone      n    weight (refit on validation)   scenario logloss   elo logloss`);
const behindElo: string[] = [];
for (const m of MILESTONES) {
  if (m.event === null) continue;
  const mine = cases.filter((c) => c.key === m.key);
  if (mine.length === 0) continue;
  const scenario = score(scenarioPredictions(mine)).logLoss;
  const elo = score(mine.map((c) => ({ p: c.prior, outcome: c.outcome }))).logLoss;
  if (scenario >= elo) behindElo.push(m.label);
  console.log(
    `   ${m.label.padEnd(13)} ${String(mine.length).padStart(4)}    ${SCENARIO_WEIGHTS[m.key].toFixed(2)} (${refit[m.key]?.toFixed(2) ?? "–"})                ${scenario.toFixed(4)}             ${elo.toFixed(4)}`,
  );
}
const scenarioPreds = scenarioPredictions(cases);
const scenarioAll = score(scenarioPreds);
const calibrationD = inRunReliability(cases.map((c, i) => ({ matchId: c.matchId, model: scenarioPreds[i]! })));
console.log(`   all          ${line(scenarioAll)}`);
console.log(`   reliability from the favourite's side:`);
console.log(curve(calibrationD));
const tailsD = byBand(cases.map((c, i) => ({ band: c.band, matchId: c.matchId, ...scenarioPreds[i]! })));

const gateA = eloScores.get(fitted)!.logLoss <= eloScores.get(400)!.logLoss;
const gateB = h2hGain < 0;
const offC = offBands(tailsC);
const gateC =
  inRun.model.logLoss < inRun.elo.logLoss &&
  inRun.model.ece < 0.05 &&
  offC.length === 0 &&
  byBucket[byBucket.length - 1]!.elo - byBucket[byBucket.length - 1]!.model >
    byBucket[0]!.elo - byBucket[0]!.model;
const offD = offBands(tailsD);
const failuresD = [
  ...(behindElo.length > 0 ? [`behind elo at ${behindElo.join(", ")}`] : []),
  ...(scenarioAll.ece >= 0.05 ? [`ece ${scenarioAll.ece.toFixed(3)}`] : []),
  ...(offD.length > 0 ? [`tail clearly off in ${offD.join(", ")}`] : []),
];

const bandNote = (tails: BandTail[]) => {
  const thin = bandsWhere(tails, "insufficient");
  const unsure = bandsWhere(tails, "uncertain");
  if (thin.length === tails.length) {
    console.log(`      tails unchecked: no band has ${MIN_TAIL_MATCHES} matches at 80%+`);
    return;
  }
  if (thin.length > 0) console.log(`      too little data in ${thin.join(", ")} (under ${MIN_TAIL_MATCHES} matches at 80%+)`);
  if (unsure.length > 0) console.log(`      off by 5+ pts but within noise in ${unsure.join(", ")}`);
};

const validationModel = buildBandedWinProbModels(
  extractAllRuns(trainDetails.filter((d) => d.date < innerCut)),
);
console.log(`\nE. Per-band in-run cap, fitted on validation and pulled toward 2.5 (NOT applied)`);
console.log(`   band          matches at 80%+   fitted   pulled   finished runs: validation model / tested model`);
for (const c of fitBandCaps(validationModel, trainDetails.filter((d) => d.date >= innerCut), CAP_GRID)) {
  console.log(
    `   ${c.band.padEnd(12)} ${String(c.matches).padStart(8)}          ${c.fitted.toFixed(2)}     ${c.cap.toFixed(2)}     ${String(validationModel.bands[c.band]?.overall.n ?? 0).padStart(4)} / ${banded.bands[c.band]?.overall.n ?? 0}`,
  );
}
console.log(`\nGate`);
console.log(`   A  train-fitted divisor beats 400 on held-out games        ${gateA ? "pass" : "FAIL"}`);
console.log(
  `   B  head-to-head improves on elo alone                      ${gateB ? "pass" : "FAIL"}`,
);
console.log(
  `   C  in-run beats elo, calibrated overall and in the tails  ${gateC ? "pass" : `FAIL${offC.length > 0 ? ` (tail clearly off in ${offC.join(", ")})` : ""}`}`,
);
bandNote(tailsC);
console.log(
  `   D  scenarios beat elo, calibrated overall and in tails    ${failuresD.length === 0 ? "pass" : `FAIL (${failuresD.join("; ")})`}`,
);
bandNote(tailsD);

store.close();
