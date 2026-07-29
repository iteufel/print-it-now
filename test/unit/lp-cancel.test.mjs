import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lpFallback } from "../../dist/internal.js";

const { isNotCancellableMessage } = lpFallback;

describe("isNotCancellableMessage", () => {
  it("matches the prose cancel emits for a finished job", () => {
    // Exact wording from `cancel` under LC_ALL=C when the job has already left
    // the queue -- the race the e2e "cancels a job" test hits on a fast printer.
    assert.equal(
      isNotCancellableMessage("Job #8 is already completed - can't cancel."),
      true,
    );
    assert.equal(isNotCancellableMessage("Job #3 is already canceled - can't cancel."), true);
    assert.equal(isNotCancellableMessage("Job #3 is already cancelled - can't cancel."), true);
    assert.equal(isNotCancellableMessage("Job #1 is already aborted - can't cancel."), true);
  });

  it("matches a job or queue that was never there", () => {
    assert.equal(isNotCancellableMessage("cancel: Job #999 does not exist."), true);
    assert.equal(isNotCancellableMessage("Destination \"Ghost\" does not exist."), true);
    assert.equal(isNotCancellableMessage("Job not found."), true);
  });

  it("leaves genuine backend failures alone", () => {
    assert.equal(isNotCancellableMessage("Permission denied"), false);
    assert.equal(isNotCancellableMessage("Unable to connect to server"), false);
    assert.equal(isNotCancellableMessage("exit code 1"), false);
  });
});
