import assert from "node:assert/strict";
import test from "node:test";
import { carriesMention, insertMention, mentionChoices, mentionQuery } from "../src/mention.ts";

test("the mention query is the word being typed after a trailing @", () => {
  assert.equal(mentionQuery("@"), "");
  assert.equal(mentionQuery("what do you think @q"), "q");
  assert.equal(mentionQuery("line one\n@al"), "al");
  assert.equal(mentionQuery("mail alice@example"), null);
  assert.equal(mentionQuery("@QM what now"), null);
  assert.equal(mentionQuery("no mention here"), null);
});

test("accepting a candidate replaces only the token being typed", () => {
  assert.equal(insertMention("@q", "QM"), "@QM ");
  assert.equal(insertMention("ping @al", "Alice Tan"), "ping @Alice Tan ");
  assert.equal(insertMention("mail bob@example then @", "QM"), "mail bob@example then @QM ");
  assert.equal(insertMention("nothing to replace", "QM"), "nothing to replace");
});

test("choices list the assistant first, then members, filtered by the query", () => {
  assert.deepEqual(mentionChoices("QM", ["Alice", "Bob"], ""), [
    { name: "QM", assistant: true },
    { name: "Alice", assistant: false },
    { name: "Bob", assistant: false },
  ]);
  assert.deepEqual(mentionChoices("QM", ["Alice", "Bob"], "B"), [{ name: "Bob", assistant: false }]);
  assert.deepEqual(mentionChoices(null, ["Alice"], ""), [{ name: "Alice", assistant: false }]);
  assert.deepEqual(mentionChoices("QM", ["qm", " ", "Alice", "alice"], ""), [
    { name: "QM", assistant: true },
    { name: "Alice", assistant: false },
  ]);
  assert.deepEqual(mentionChoices("QM", ["Alice"], "zz"), []);
});

test("a send addresses the assistant only while its mention is still in the text", () => {
  assert.equal(carriesMention("@QM what is the risk?", "QM"), true);
  assert.equal(carriesMention("what is the risk?", "QM"), false);
  assert.equal(carriesMention("QM what is the risk?", "QM"), false);
});
