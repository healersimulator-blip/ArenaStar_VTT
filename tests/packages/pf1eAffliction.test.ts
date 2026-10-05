import { describe, expect, test } from "vitest";
import {
  PF1E_POISON_FIXTURES,
  activatePF1eDelayPoison,
  applyPF1ePoisonExposure,
  applyPF1ePoisonExposureToTarget,
  emptyPF1ePoisonTargetState,
  endPF1eDelayPoison,
  nextPF1eQueuedPoisonExposure,
  neutralizePF1ePoisonCourse,
  pf1eCreaturePoisonBaseDc,
  pf1ePoisonDefinitionIdentity,
  pf1ePoisonExposureSaveDc,
  pf1ePoisonOngoingSaveDc,
  resolveNextPF1eQueuedPoisonExposure,
  resolvePF1ePoisonFrequencySave,
  resolvePF1ePoisonOnset,
  setPF1ePoisonCourseEffects,
  validatePF1ePoisonDefinition,
  validatePF1ePoisonTargetState,
  validatePoisonFixtures,
  type PF1ePoisonCourse,
  type PF1ePoisonDefinition,
} from "../../src/packages/pf1e/afflictions";

const greenblood = PF1E_POISON_FIXTURES.find((profile) => profile.id === "greenblood-oil") as PF1ePoisonDefinition;
const octopus = PF1E_POISON_FIXTURES.find((profile) => profile.id === "giant-octopus-poison") as PF1ePoisonDefinition;
const wyvern = PF1E_POISON_FIXTURES.find((profile) => profile.id === "wyvern-poison") as PF1ePoisonDefinition;
const spider = PF1E_POISON_FIXTURES.find((profile) => profile.id === "medium-spider-venom") as PF1ePoisonDefinition;

const source = { kind: "attack" as const, actionId: "attack-1", actorId: "attacker", itemId: "fang" };

function expose(input: Partial<Parameters<typeof applyPF1ePoisonExposure>[0]> & {
  definition?: PF1ePoisonDefinition;
  existing?: PF1ePoisonCourse | null;
} = {}) {
  const definition = input.definition ?? greenblood;
  const result = applyPF1ePoisonExposure({
    targetId: "target",
    definition,
    newCourseId: "course-1",
    exposureId: "exposure-1",
    route: "injury",
    doseCount: 1,
    exposedAt: 0,
    resolvedAt: 0,
    savePassed: false,
    source,
    ...input,
  }, input.existing ?? null);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function courseOf(definition = greenblood, id = "course-1"): PF1ePoisonCourse {
  const result = applyPF1ePoisonExposure({
    targetId: "target",
    definition,
    newCourseId: id,
    exposureId: `${id}-exposure-1`,
    route: definition.delivery[0] as "injury",
    doseCount: 1,
    exposedAt: 0,
    resolvedAt: 0,
    savePassed: false,
    source,
  });
  if (!result.ok || result.value.course === null) throw new Error(result.ok ? "expected course" : result.error);
  return result.value.course;
}

function save(course: PF1ePoisonCourse, id: string, passed: boolean, now: number) {
  const result = resolvePF1ePoisonFrequencySave({ course, attemptId: id, passed, now });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("Core PF1e poison profiles and exposure rules", () => {
  test("fixture definitions are source-validated and retain the Cure wording distinction", () => {
    expect(validatePoisonFixtures()).toEqual([]);
    expect(validatePF1ePoisonDefinition(greenblood).ok).toBe(true);
    expect(octopus.cure).toEqual({ successesRequired: 2, consecutive: false });
    expect(wyvern.cure).toEqual({ successesRequired: 2, consecutive: true });
    expect(pf1ePoisonDefinitionIdentity(octopus)).not.toBe(pf1ePoisonDefinitionIdentity({ ...octopus, baseDC: 18 }));
    expect(validatePF1ePoisonDefinition({ ...wyvern, ruleset: "unchained" }).ok).toBe(false);
  });

  test("creature-derived DC uses the source creature's HD and Constitution modifier", () => {
    expect(pf1eCreaturePoisonBaseDc(8, 4)).toBe(18);
    expect(pf1eCreaturePoisonBaseDc(7, 2)).toBe(15);
    expect(pf1eCreaturePoisonBaseDc(0, 2)).toBeNull();
  });

  test("exposure DC and ongoing DC use separate active-dose calculations", () => {
    expect(pf1ePoisonOngoingSaveDc(14, 1)).toBe(14);
    expect(pf1ePoisonOngoingSaveDc(14, 3)).toBe(18);
    expect(pf1ePoisonExposureSaveDc(14, 0, 1)).toBe(14);
    expect(pf1ePoisonExposureSaveDc(14, 2, 1)).toBe(18);
    expect(pf1ePoisonExposureSaveDc(14, 1, 3)).toBe(20);
    expect(pf1ePoisonExposureSaveDc(14, -1, 1)).toBeNull();
  });

  test("successful Greenblood exposure creates no course or effect; failed exposure is immediate", () => {
    const saved = expose({ exposureId: "saved", savePassed: true });
    expect(saved.course).toBeNull();
    expect(saved.attempt).toMatchObject({ outcome: "resisted", dc: 13, passed: true });
    expect(saved.effects).toEqual([]);

    const failed = expose();
    expect(failed.course).toMatchObject({
      state: "active",
      doseCount: 1,
      attemptsScheduled: 4,
      nextAttemptAt: 6,
      frequencyEndAt: 24,
      cureProgress: 0,
    });
    expect(failed.effects).toEqual([{ kind: "damage", target: "abilityDamage", ability: "con", formula: "1" }]);
    expect(failed.course?.doseEvents[0]).toMatchObject({
      route: "injury", doseCount: 1, initialSaveDC: 13, initialSavePassed: false,
      source: { actorId: "attacker", itemId: "fang", actionId: "attack-1" },
    });
  });

  test("target state validates its id-keyed courses and stores successful/immune exposure IDs for replay safety", () => {
    const empty = emptyPF1ePoisonTargetState("target");
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const successful = applyPF1ePoisonExposureToTarget({
      state: empty.value,
      exposure: { targetId: "target", definition: greenblood, newCourseId: "unused-course", exposureId: "resisted-e1", route: "injury", doseCount: 1, exposedAt: 0, source },
      savePassed: true,
      resolvedAt: 0,
    });
    expect(successful.ok).toBe(true);
    if (!successful.ok) return;
    expect(Object.keys(successful.value.state.courses)).toHaveLength(0);
    expect(validatePF1ePoisonTargetState(successful.value.state, "target").ok).toBe(true);
    const replay = applyPF1ePoisonExposureToTarget({
      state: successful.value.state,
      exposure: { targetId: "target", definition: greenblood, newCourseId: "different-id", exposureId: "resisted-e1", route: "injury", doseCount: 1, exposedAt: 0, source },
      savePassed: false,
      resolvedAt: 100,
    });
    expect(replay.ok && replay.value.resolution?.duplicate).toBe(true);
    expect(replay.ok && replay.value.state.courses).toEqual({});

    const immune = applyPF1ePoisonExposureToTarget({
      state: successful.value.state,
      exposure: { targetId: "target", definition: greenblood, exposureId: "immune-e1", route: "injury", doseCount: 1, exposedAt: 1, source },
      immune: true,
      resolvedAt: 1,
    });
    expect(immune.ok && immune.value.resolution?.attempt.outcome).toBe("immune");
    expect(immune.ok && immune.value.resolution?.attempt.dc).toBeNull();
    expect(immune.ok && Object.keys(immune.value.state.exposureAttempts)).toHaveLength(2);

    const malformed = {
      ...successful.value.state,
      targetId: "other-target",
    };
    expect(validatePF1ePoisonTargetState(malformed, "target").ok).toBe(false);
  });

  test("successful re-exposure changes neither dose count nor cure progress", () => {
    const first = courseOf(wyvern);
    const progress = save(first, "save-one", true, 6).course;
    const resisted = applyPF1ePoisonExposure({
      targetId: "target", definition: wyvern, exposureId: "re-exposure-success",
      route: "injury", doseCount: 1, exposedAt: 7, resolvedAt: 7, savePassed: true, source,
    }, progress);
    expect(resisted.ok).toBe(true);
    if (!resisted.ok) return;
    expect(resisted.value.course).toEqual(progress);
    expect(resisted.value.attempt.dc).toBe(19);
    expect(resisted.value.effects).toEqual([]);
  });

  test("onset suppresses exposure effects until its due boundary; a no-frequency profile is one-shot", () => {
    const onsetProfile: PF1ePoisonDefinition = {
      ...greenblood,
      id: "onset-fixture",
      name: "Onset fixture",
      onset: { value: 1, unit: "minute" },
      frequency: null,
      effects: { immediate: [], periodic: [], oneShot: [{ kind: "damage", target: "abilityDamage", ability: "con", formula: "1d4" }] },
    };
    const exposure = expose({ definition: onsetProfile, newCourseId: "onset-course", exposureId: "onset-exposure" });
    expect(exposure.effects).toEqual([]);
    expect(exposure.course).toMatchObject({ state: "onset", onsetDueAt: 60, nextAttemptAt: 60, attemptsScheduled: 1 });
    const course = exposure.course as PF1ePoisonCourse;
    const early = resolvePF1ePoisonOnset({ course, attemptId: "onset-early", now: 59 });
    expect(early.ok).toBe(false);
    const due = resolvePF1ePoisonOnset({ course, attemptId: "onset-due", now: 60 });
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.course.state).toBe("expired");
    expect(due.value.effects).toEqual(onsetProfile.effects.oneShot);
    expect(due.value.course.attemptsResolved).toBe(1);
  });

  test("finite frequency ends after its final save; duplicate attempts do not apply effects twice", () => {
    const initial = courseOf(greenblood);
    const first = save(initial, "tick-one", false, 6);
    expect(first.effects).toEqual(greenblood.effects.periodic);
    const duplicate = save(first.course, "tick-one", false, 100);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.effects).toEqual([]);
    let current = first.course;
    for (let index = 2; index <= 4; index += 1) {
      const result = save(current, `tick-${index}`, false, index * 6);
      current = result.course;
    }
    expect(current.state).toBe("expired");
    expect(current.endReason).toBe("frequency-ended");
    expect(current.nextAttemptAt).toBeNull();
  });

  test("two unqualified octopus cure successes may be nonconsecutive; wyvern failure resets its streak", () => {
    let octopusCourse = courseOf(octopus);
    octopusCourse = save(octopusCourse, "oct-success-1", true, 6).course;
    octopusCourse = save(octopusCourse, "oct-failure", false, 12).course;
    expect(octopusCourse.cureProgress).toBe(1);
    const octCured = save(octopusCourse, "oct-success-2", true, 18);
    expect(octCured.cured).toBe(true);
    expect(octCured.course.state).toBe("cured");

    let wyvernCourse = courseOf(wyvern, "wyvern-course");
    wyvernCourse = save(wyvernCourse, "wyv-success", true, 6).course;
    expect(wyvernCourse.cureProgress).toBe(1);
    const exposureSuccess = applyPF1ePoisonExposure({
      targetId: "target", definition: wyvern, exposureId: "wyv-resisted-dose", route: "injury",
      doseCount: 1, exposedAt: 7, resolvedAt: 7, savePassed: true, source,
    }, wyvernCourse);
    expect(exposureSuccess.ok && exposureSuccess.value.course?.cureProgress).toBe(1);
    const failedDose = applyPF1ePoisonExposure({
      targetId: "target", definition: wyvern, exposureId: "wyv-failed-dose", route: "injury",
      doseCount: 1, exposedAt: 8, resolvedAt: 8, savePassed: false, source,
    }, wyvernCourse);
    expect(failedDose.ok).toBe(true);
    if (!failedDose.ok) return;
    expect(failedDose.value.course?.cureProgress).toBe(0);
    expect(failedDose.value.course?.doseCount).toBe(2);
    expect(failedDose.value.attempt.dc).toBe(19);
  });

  test("three failed spider doses produce DC 18 and eight rounds; odd duration rounds down per dose", () => {
    const first = expose({ definition: spider, newCourseId: "spider-course", exposureId: "spider-1", exposedAt: 0 });
    let current = first.course as PF1ePoisonCourse;
    const second = applyPF1ePoisonExposure({
      targetId: "target", definition: spider, exposureId: "spider-2", route: "injury", doseCount: 1,
      exposedAt: 1, resolvedAt: 1, savePassed: false, source,
    }, current);
    expect(second.ok).toBe(true);
    if (!second.ok || second.value.course === null) return;
    current = second.value.course;
    const third = applyPF1ePoisonExposure({
      targetId: "target", definition: spider, exposureId: "spider-3", route: "injury", doseCount: 1,
      exposedAt: 2, resolvedAt: 2, savePassed: false, source,
    }, current);
    expect(third.ok).toBe(true);
    if (!third.ok || third.value.course === null) return;
    current = third.value.course;
    expect(current.doseCount).toBe(3);
    expect(pf1ePoisonOngoingSaveDc(spider.baseDC, current.doseCount)).toBe(18);
    expect(current.attemptsScheduled).toBe(8);
    expect(current.frequencyEndAt).toBe(48);
    expect(third.value.effects).toHaveLength(1); // one effect for this failed exposure, not one per dose

    const spiderFrequency = spider.frequency;
    if (spiderFrequency === null) throw new Error("fixture has no frequency");
    const odd: PF1ePoisonDefinition = {
      ...spider,
      id: "odd-duration-venom",
      name: "Odd duration venom",
      frequency: { ...spiderFrequency, intervals: 5 },
    };
    const oddFirst = expose({ definition: odd, newCourseId: "odd-course", exposureId: "odd-1" });
    const oddSecond = applyPF1ePoisonExposure({
      targetId: "target", definition: odd, exposureId: "odd-2", route: "injury", doseCount: 1,
      exposedAt: 1, resolvedAt: 1, savePassed: false, source,
    }, oddFirst.course);
    expect(oddSecond.ok && oddSecond.value.extensionIntervals).toBe(2);
    expect(oddSecond.ok && oddSecond.value.course?.attemptsScheduled).toBe(7);
  });

  test("simultaneous ingested batches use one candidate DC, add all doses and apply one effect", () => {
    const ingested: PF1ePoisonDefinition = { ...spider, id: "ingested-venom", name: "Ingested venom", delivery: ["ingested"] };
    const failed = applyPF1ePoisonExposure({
      targetId: "target", definition: ingested, newCourseId: "ingested-course", exposureId: "batch-1",
      route: "ingested", doseCount: 3, exposedAt: 0, resolvedAt: 0, savePassed: false, source,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.attempt.dc).toBe(18);
    expect(failed.value.course?.doseCount).toBe(3);
    expect(failed.value.course?.attemptsScheduled).toBe(8);
    expect(failed.value.effects).toHaveLength(1);

    const resisted = applyPF1ePoisonExposure({
      targetId: "target", definition: ingested, exposureId: "batch-success", route: "ingested",
      doseCount: 3, exposedAt: 1, resolvedAt: 1, savePassed: true, source,
    }, failed.value.course);
    expect(resisted.ok).toBe(true);
    if (!resisted.ok) return;
    expect(resisted.value.course?.doseCount).toBe(3);
    expect(resisted.value.extensionIntervals).toBe(0);
    expect(resisted.value.effects).toEqual([]);
  });

  test("exact poison identities stay separate; Delay Poison pauses without backfill and queues in order", () => {
    const stateResult = emptyPF1ePoisonTargetState("target");
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) return;
    let state = stateResult.value;
    const first = applyPF1ePoisonExposureToTarget({
      state,
      exposure: { targetId: "target", definition: greenblood, newCourseId: "green-course", exposureId: "green-e1", route: "injury", doseCount: 1, exposedAt: 0, source },
      savePassed: false,
      resolvedAt: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.value.state;

    const other = applyPF1ePoisonExposureToTarget({
      state,
      exposure: { targetId: "target", definition: { ...greenblood, id: "greenblood-v2", version: 2 }, newCourseId: "green-v2-course", exposureId: "green-v2-e1", route: "injury", doseCount: 1, exposedAt: 1, source },
      savePassed: false,
      resolvedAt: 1,
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    state = other.value.state;
    expect(Object.keys(state.courses)).toHaveLength(2);

    const delayed = activatePF1eDelayPoison(state, 3);
    expect(delayed.ok).toBe(true);
    if (!delayed.ok) return;
    state = delayed.value;
    const queued = applyPF1ePoisonExposureToTarget({
      state,
      exposure: { targetId: "target", definition: greenblood, exposureId: "green-e2", route: "injury", doseCount: 1, exposedAt: 4, source },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.queued).toBe(true);
    state = queued.value.state;
    expect(state.queuedExposures).toHaveLength(1);
    const pausedSave = resolvePF1ePoisonFrequencySave({ course: state.courses["green-course"] as PF1ePoisonCourse, attemptId: "paused", now: 6, passed: false });
    expect(pausedSave.ok).toBe(false);

    const resumed = endPF1eDelayPoison(state, 15);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    state = resumed.value;
    expect(state.courses["green-course"]?.nextAttemptAt).toBe(18); // 12 seconds paused; no missed save banked
    const next = nextPF1eQueuedPoisonExposure(state);
    expect(next.ok && next.value?.dc).toBe(15);
    const queuedResult = resolveNextPF1eQueuedPoisonExposure({ state, exposureId: "green-e2", savePassed: false, now: 15 });
    expect(queuedResult.ok).toBe(true);
    if (!queuedResult.ok) return;
    expect(queuedResult.value.state.queuedExposures).toHaveLength(0);
    expect(queuedResult.value.resolution?.course?.doseCount).toBe(2);
    expect(queuedResult.value.resolution?.attempt.timestamp).toBe(4);
    expect(queuedResult.value.resolution?.attempt.resolvedAt).toBe(15);
  });

  test("cure/neutralize ends source-owned effects but does not rewrite damage already applied", () => {
    let course = courseOf(wyvern);
    const withEffect = setPF1ePoisonCourseEffects(course, ["poison-effect-1"]);
    expect(withEffect.ok).toBe(true);
    if (!withEffect.ok) return;
    course = withEffect.value;
    const state = emptyPF1ePoisonTargetState("target");
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const inserted = { ...state.value, courses: { [course.id]: course } };
    const neutralized = neutralizePF1ePoisonCourse({ state: inserted, courseId: course.id, attemptId: "neutralize-1", now: 9 });
    expect(neutralized.ok).toBe(true);
    if (!neutralized.ok) return;
    expect(neutralized.value.course.state).toBe("cured");
    expect(neutralized.value.effectIdsToRemove).toEqual(["poison-effect-1"]);
    expect(neutralized.value.course.activeEffectIds).toEqual([]);
    expect(neutralized.value.course.endReason).toBe("neutralized");
  });
});
