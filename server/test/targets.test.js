import test from "node:test";
import assert from "node:assert/strict";
import { design } from "../src/designer.js";
import { designTargetsBlock } from "../src/designer.js";
import { designRequest, modelSaveRequest } from "../src/schemas.js";

const spec = {
  schemaVersion: "1.0",
  name: "Target test",
  category: "Mechanical Equipment",
  units: "mm",
  parameters: [
    { name: "Width", type: "Length", value: 400 },
    { name: "Height", type: "Length", value: 100 },
  ],
  parts: [
    {
      id: "rail",
      name: "Side Rail",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Width]", y: 2, z: "[Height]" },
      },
    },
    {
      id: "rung",
      name: "Rung",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 10, z: 2 } },
    },
  ],
};

const targets = [
  {
    partId: "rail",
    partName: "Side Rail",
    point: { x: 12.345, y: -4, z: 100 },
    normal: { x: 1, y: 0, z: 0 },
    note: "Vát góc tại điểm này 45°.",
  },
];

test("target block carries the selected part, its parameters and the pinned point", () => {
  const block = designTargetsBlock(targets, spec);
  assert.match(block, /ĐỐI TƯỢNG ĐƯỢC CHỌN/);
  assert.match(block, /partId="rail"/);
  assert.match(block, /Side Rail/);
  assert.match(block, /Width/);
  assert.match(block, /12\.3/);
  assert.match(block, /Vát góc/);
  assert.ok(!block.includes('partId="rung"'), "unselected parts are not listed");
});

test("target request and saved annotations are validated", () => {
  assert.equal(designRequest.safeParse({ prompt: "sửa part này", targets }).success, true);
  assert.equal(
    designRequest.safeParse({ prompt: "sửa part này", targets: [{ partName: "Rail" }] }).success,
    false,
  );
  assert.equal(
    modelSaveRequest.safeParse({
      spec,
      annotations: [
        {
          id: "note-1",
          partId: "rail",
          partName: "Side Rail",
          point: { x: 1, y: 2, z: 3 },
          text: "Ghi chú",
        },
      ],
    }).success,
    true,
  );
});

test("design receives targets in the model prompt", async () => {
  let sent = null;
  const answer = {
    ...spec,
    parameters: spec.parameters.map((parameter) =>
      parameter.name === "Width" ? { ...parameter, value: 450 } : parameter,
    ),
  };
  await design({
    prompt: "Sửa đúng part được chọn.",
    currentSpec: spec,
    targets,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages) => {
      sent = messages;
      return { json: answer, text: "", usage: null };
    },
  });

  assert.ok(sent, "the model was called");
  assert.ok(
    sent.some((message) => String(message.content).includes("ĐỐI TƯỢNG ĐƯỢC CHỌN")),
    "the target block reaches the model",
  );
});
