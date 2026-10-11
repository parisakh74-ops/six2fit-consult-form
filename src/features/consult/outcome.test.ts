import { describe, expect, it } from "vitest";

import { evaluateOutcome, normalizePhone, scoreModule } from "./outcome";
import { budgetOptionsFor } from "./schema";
import { budgetQuestions, currencyCountryFromDialCode } from "./assessmentConfig";
import type { ConsultAnswers } from "./types";

const base: Partial<ConsultAnswers> = {
  age: 30,
  service_interest: ["training"],
  health_flags: [],
  ts_01_has_limitation: "no",
  ts_02_categories: [],
  modules: {},
};

describe("outcome priority", () => {
  it("returns GREEN when nothing is flagged", () => {
    expect(evaluateOutcome(base).safety_outcome).toBe("GREEN");
  });

  it("returns YELLOW_REVIEW for a yellow health flag", () => {
    const result = evaluateOutcome({ ...base, health_flags: ["diabetes_hypoglycemia_risk"] });
    expect(result.safety_outcome).toBe("YELLOW_REVIEW");
    expect(result.review_required).toBe(true);
    expect(result.general_plan_eligible).toBe(true);
  });

  it("red overrides green", () => {
    const result = evaluateOutcome({ ...base, health_flags: ["liver_cirrhosis_failure"] });
    expect(result.safety_outcome).toBe("RED_SPECIALIST");
    expect(result.general_plan_eligible).toBe(false);
  });

  it("red overrides yellow when both are present", () => {
    const result = evaluateOutcome({
      ...base,
      health_flags: ["diabetes_hypoglycemia_risk", "eating_disorder_history"],
    });
    expect(result.safety_outcome).toBe("RED_SPECIALIST");
  });

  it("under 18 forces the specialist route", () => {
    expect(evaluateOutcome({ ...base, age: 16 }).safety_outcome).toBe("RED_SPECIALIST");
  });

  it("hard red flag overrides an otherwise low module score", () => {
    const answers: Partial<ConsultAnswers> = {
      ...base,
      ts_01_has_limitation: "yes",
      ts_02_categories: ["cardiovascular"],
      ts_03_clearance: "no",
      modules: {
        cardiovascular: {
          diagnosis: "x",
          onset: "gt_6m",
          recovery: "improving",
          pain: "none",
          reaction: "fine",
          clearance: "cleared",
          red_flags: ["chest_pain"],
        },
      },
    };
    const result = evaluateOutcome(answers);
    expect(result.module_scores["module_score_cardiovascular"]).toBe(0);
    expect(result.hard_red_flags).toContain("cardiovascular:chest_pain");
    expect(result.safety_outcome).toBe("RED_SPECIALIST");
  });

  it("a training ban in TS-03 is a hard red flag", () => {
    const result = evaluateOutcome({
      ...base,
      ts_01_has_limitation: "yes",
      ts_02_categories: ["tendon"],
      ts_03_clearance: "yes",
      modules: { tendon: {} },
    });
    expect(result.safety_outcome).toBe("RED_SPECIALIST");
  });

  it("scores each module independently and bands mid scores as yellow", () => {
    const answers: Partial<ConsultAnswers> = {
      ...base,
      ts_01_has_limitation: "yes",
      ts_02_categories: ["tendon", "neurological"],
      ts_03_clearance: "no",
      modules: {
        tendon: {
          onset: "2_6w", // 2
          recovery: "unchanged", // 2
          pain: "mild", // 1
          reaction: "fine", // 0
          clearance: "cleared", // 0
        },
        neurological: {
          onset: "gt_6m",
          recovery: "improving",
          pain: "none",
          reaction: "fine",
          clearance: "cleared",
        },
      },
    };
    expect(scoreModule("tendon", answers.modules!["tendon"])).toBe(5);
    const result = evaluateOutcome(answers);
    expect(result.module_scores["module_score_tendon"]).toBe(5);
    expect(result.module_scores["module_score_neurological"]).toBe(0);
    expect(result.safety_outcome).toBe("YELLOW_REVIEW");
  });

  it("a module score of 11 or more is a specialist route", () => {
    const result = evaluateOutcome({
      ...base,
      ts_01_has_limitation: "yes",
      ts_02_categories: ["respiratory"],
      ts_03_clearance: "no",
      modules: {
        respiratory: {
          onset: "lt_2w", // 3
          recovery: "worsening", // 4
          pain: "severe", // 5
          reaction: "much_worse", // 4
          clearance: "not_assessed", // 3
        },
      },
    });
    expect(result.module_scores["module_score_respiratory"]).toBe(19);
    expect(result.safety_outcome).toBe("RED_SPECIALIST");
  });
});

describe("health flags", () => {
  it("competitive athlete only routes to specialist programme, no safety block", () => {
    const r = evaluateOutcome({ ...base, health_flags: ["competitive_athlete"] });
    expect(r.safety_outcome).toBe("GREEN");
    expect(r.specialist_routing).toBe(true);
    expect(r.specialist_routing_flags).toEqual(["competitive_athlete"]);
  });

  it("weakness, appetite and unintentional weight loss stay independent flags", () => {
    const r = evaluateOutcome({ ...base, health_flags: ["severe_weakness_syncope", "unintentional_weight_loss"] });
    expect(r.nutrition_red_reasons).toEqual(["severe_weakness_syncope", "unintentional_weight_loss"]);
  });

  it("type 2 diabetes alone (no flag selected) does not raise a flag", () => {
    expect(evaluateOutcome(base).review_required).toBe(false);
  });
});

describe("currency routing", () => {
  it("+98 WhatsApp number uses Toman, others USD", () => {
    expect(currencyCountryFromDialCode("+98")).toBe("IR");
    expect(currencyCountryFromDialCode("+971")).toBe("INTL");
  });

  it("shows only the Toman question for IR", () => {
    const q = budgetOptionsFor("IR");
    expect(q.currency).toBe("IRT");
    expect(q).toBe(budgetQuestions.IR);
    expect(q.options).toHaveLength(4);
    expect(q.options.some((o) => o.label.includes("$"))).toBe(false);
  });

  it("shows only the USD question outside IR", () => {
    for (const code of ["US", "DE", "AE", "TR"]) {
      const q = budgetOptionsFor(code);
      expect(q.currency).toBe("USD");
      expect(q.question).toBe(
        "به‌طور میانگین در ماه چقدر برای سلامت، تغذیه و ورزش هزینه می‌کنید؟",
      );
      expect(q.options.every((o) => o.label.includes("دلار"))).toBe(true);
    }
  });
});

describe("phone normalization", () => {
  it("normalizes local Iranian numbers", () => {
    expect(normalizePhone("+98", "0912 345 6789")).toBe("+989123456789");
    expect(normalizePhone("+98", "989123456789")).toBe("+989123456789");
  });
});

import { searchCountries } from "./assessmentConfig";
describe("country search", () => {
  it("defaults to US, Canada, Iran first", () => {
    expect(searchCountries("").slice(0, 3).map((c) => c.iso)).toEqual(["US", "CA", "IR"]);
  });
  it("+1 returns US and Canada as separate entries", () => {
    expect(searchCountries("+1").slice(0, 2).map((c) => c.iso)).toEqual(["US", "CA"]);
  });
  it("matches Persian name, English name and ISO code", () => {
    expect(searchCountries("ایر")[0]!.iso).toBe("IR");
    expect(searchCountries("ger")[0]!.iso).toBe("DE");
    expect(searchCountries("ae")[0]!.iso).toBe("AE");
  });
});
