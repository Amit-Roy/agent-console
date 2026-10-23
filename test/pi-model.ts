import assert from "node:assert/strict";
import {
  AUTOMATION_PI_MODELS,
  defaultPiModel,
  isAutomationPiModel,
  selectAutomationPiModel,
} from "../server/providers/pi-model.ts";

const direct = "nvidia/nvidia/nemotron-3-ultra-550b-a55b";
const retired = "nvidia/nvidia/nemotron-3-super-120b-a12b";
const superVl = "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b";
const router = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
const vision = "nvidia/meta/llama-3.2-11b-vision-instruct";

// Real credential/catalog ordering put a vision model first. Automation must
// select the reviewed coding model, independent of discovery order.
assert.equal(selectAutomationPiModel([vision, router, direct]), direct);
assert.equal(selectAutomationPiModel([direct, vision, router]), direct);
assert.equal(selectAutomationPiModel([vision, router]), router);
assert.equal(selectAutomationPiModel([router, direct], router), router);
assert.equal(selectAutomationPiModel([direct], direct), direct);
assert.throws(() => selectAutomationPiModel([vision]), /no approved coding model/);
assert.throws(() => selectAutomationPiModel([]), /no approved coding model/);
assert.throws(() => selectAutomationPiModel([direct], router), /unavailable/);
assert.throws(() => selectAutomationPiModel([vision, direct], vision), /not approved/);
assert.throws(
  () => selectAutomationPiModel([direct], "nvidia/nemotron-3-ultra-550b-a55b"),
  /not approved/,
);
// NVIDIA 404s nemotron-3-super; a catalog that still lists it must fall through to the next working NIM model.
assert.equal(isAutomationPiModel(retired), false);
assert.equal(selectAutomationPiModel([retired, superVl, router]), superVl);
assert.equal(selectAutomationPiModel([retired, router]), router);
assert.throws(() => selectAutomationPiModel([direct], `${direct}-unknown`), /not approved/);
assert.throws(() => selectAutomationPiModel([direct], ""), /not approved/);
assert.equal(isAutomationPiModel(direct), true);
assert.equal(isAutomationPiModel(router), true);
assert.equal(isAutomationPiModel(vision), false);
assert.equal(Object.isFrozen(AUTOMATION_PI_MODELS), true);

// Deliberately selected manual models remain supported by the full catalog;
// only the unattended selector rejects models outside the reviewed list.
assert.equal(defaultPiModel([vision, router, direct]), direct);
assert.equal(defaultPiModel([vision, router]), router);
assert.equal(defaultPiModel([vision]), vision);
assert.equal(defaultPiModel([]), "");

console.log("pi-model: deterministic coding selection and fail-closed overrides passed");
