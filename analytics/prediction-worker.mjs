import { estimate, backtest } from "../lib/prediction.mjs";
let datasets = {},
  evaluations = {};
self.onmessage = ({ data }) => {
  try {
    let result;
    if (data.op === "init") {
      datasets = data.datasets;
      evaluations = {};
      result = true;
    } else if (data.op === "fixed") {
      Object.assign(datasets, data.datasets);
      delete evaluations.hour24;
      delete evaluations.day7;
      result = true;
    } else if (["estimate", "backtest"].includes(data.op)) {
      const key = data.target || "snapshot";
      evaluations[key] ||= backtest(datasets[key] || []);
      result =
        data.op === "backtest"
          ? evaluations[key]
          : {
              ...estimate(datasets[key] || [], data.draft, {
                version: data.version,
                target: data.targetLabel,
                strategy: evaluations[key].selectedStrategy,
              }),
              selectedStrategy: evaluations[key].selectedStrategy,
              validation: evaluations[key].validation.metrics,
            };
    } else throw new Error("未対応の操作");
    self.postMessage({ id: data.id, result });
  } catch (e) {
    self.postMessage({ id: data.id, error: e.message });
  }
};
