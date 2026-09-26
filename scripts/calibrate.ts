import {
  eloPredictions,
  fitEloDivisor,
  inRunPredictions,
  pregamePredictions,
  ratedGames,
  reliability,
  score,
  temporalCutoff,
  type InRunObservation,
  type Prediction,
  type Scores,
} from "../src/analysis/calibration.js";
import { extractAllRuns } from "../src/analysis/splits.js";
import { ELO_DIVISOR } from "../src/analysis/stats.js";
import { buildBandedWinProbModels } from "../src/analysis/winprob.js";
import { Store } from "../src/db/db.js";

const TRAIN_SHARE = 0.7;
const DIVISORS = Array.from({ length: 201 }, (_, i) => 200 + i * 5);
const ELAPSED_BUCKETS_MIN = [0, 2, 4, 6, 8, 10, Infinity];

const store = new Store(process.argv[2] ?? "data/splitline.db");

const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;
const line = (s: Scores) =>
  `n=${String(s.n).padStart(6)}  logloss ${s.logLoss.toFixed(4)}  brier ${s.brier.toFixed(4)}  ece ${s.ece.toFixed(4)}`;
const curve = (preds: Prediction[]) =>
  reliability(preds)
    .map(
      (b) =>
        `     ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  n=${String(b.n).padStart(6)}  predicted ${pct(b.predicted)}  observed ${pct(b.observed)}`,
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
console.log(`   reliability on test, d=${fitted}:`);
console.log(curve(eloPredictions(testGames, fitted)));

const pre = pregamePredictions(trainA, testA);
const preScores = {
  elo: score(pre.elo),
  base: score(pre.base),
  bastion: score(pre.bastion),
  overworld: score(pre.overworld),
};
console.log(`\nB. Pre-match layers on the same test games (d=${ELO_DIVISOR})`);
// Each layer is judged against the one it sits on: seed deltas are applied to the head-to-head base.
const gains = {
  "head-to-head": preScores.base.logLoss - preScores.elo.logLoss,
  bastion: preScores.bastion.logLoss - preScores.base.logLoss,
  overworld: preScores.overworld.logLoss - preScores.base.logLoss,
};
const gain = (g: number) => `${g <= 0 ? "" : "+"}${g.toFixed(4)} vs its base`;
console.log(`   elo only       ${line(preScores.elo)}`);
console.log(`   + head-to-head ${line(preScores.base)}   ${gain(gains["head-to-head"])}`);
console.log(`   + bastion      ${line(preScores.bastion)}   ${gain(gains.bastion)}, rows ${pre.bastionRows}`);
console.log(`   + overworld    ${line(preScores.overworld)}   ${gain(gains.overworld)}, rows ${pre.overworldRows}`);

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
console.log(`   reliability, model:`);
console.log(curve(obs.map((o) => o.model)));

const gateA = eloScores.get(fitted)!.logLoss <= eloScores.get(400)!.logLoss;
const noHelp = Object.entries(gains)
  .filter(([, g]) => g >= 0)
  .map(([k]) => k);
const gateB = noHelp.length === 0;
const tails = reliability(obs.map((o) => o.model)).filter(
  (b) => b.n >= 30 && (b.predicted >= 0.8 || b.predicted <= 0.2),
);
const worstTail = Math.max(0, ...tails.map((b) => Math.abs(b.observed - b.predicted)));
const gateC =
  inRun.model.logLoss < inRun.elo.logLoss &&
  inRun.model.ece < 0.05 &&
  worstTail <= 0.05 &&
  byBucket[byBucket.length - 1]!.elo - byBucket[byBucket.length - 1]!.model >
    byBucket[0]!.elo - byBucket[0]!.model;

console.log(`\nGate`);
console.log(`   A  train-fitted divisor beats 400 on held-out games        ${gateA ? "pass" : "FAIL"}`);
console.log(
  `   B  every pre-match layer improves on the one beneath it    ${gateB ? "pass" : `FAIL (${noHelp.join(", ")})`}`,
);
console.log(
  `   C  in-run beats elo, calibrated overall and in the tails  ${gateC ? "pass" : `FAIL (worst tail bin off by ${(worstTail * 100).toFixed(1)} pts)`}`,
);

store.close();
