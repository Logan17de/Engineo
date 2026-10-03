// Native JSON.parse accepts these documents, including last-key-wins shadowing.
// The strict shared parser must reject them without exporting any literal key.
const credential = "SYNTHETIC_REVIEW_TOKEN";
const shadowedDepth = (key: string) =>
  `{"x":{${JSON.stringify(key)}:${"[".repeat(32)}0${"]".repeat(32)}},"x":{}}`;

export const strictConfigurationFailures = [
  {
    label: "duplicate-shadowed escaped-tab underflow",
    source: String.raw`{"x":{"Bearer\tSYNTHETIC_REVIEW_TOKEN":1e-999},"x":{}}`,
    credential,
    issueCode: "INVALID_JSON",
  },
  {
    label: "duplicate-shadowed plain Bearer underflow",
    source: `{"x":{"Bearer ${credential}":1e-999},"x":{}}`,
    credential,
    issueCode: "INVALID_JSON",
  },
  {
    label: "duplicate-shadowed Unicode-tab underflow",
    source: String.raw`{"x":{"Bearer\u0009SYNTHETIC_REVIEW_TOKEN":1e-999},"x":{}}`,
    credential,
    issueCode: "INVALID_JSON",
  },
  {
    label: "duplicate-shadowed escaped-newline underflow",
    source: String.raw`{"x":{"Bearer\nSYNTHETIC_REVIEW_TOKEN":1e-999},"x":{}}`,
    credential,
    issueCode: "INVALID_JSON",
  },
  {
    label: "duplicate-shadowed escaped-carriage-return underflow",
    source: String.raw`{"x":{"Bearer\rSYNTHETIC_REVIEW_TOKEN":1e-999},"x":{}}`,
    credential,
    issueCode: "INVALID_JSON",
  },
  {
    label: "duplicate-shadowed escaped-tab depth",
    source: shadowedDepth(`Bearer\t${credential}`),
    credential,
    issueCode: "MAX_DEPTH_EXCEEDED",
  },
  {
    label: "duplicate-shadowed escaped-newline depth",
    source: shadowedDepth(`Bearer\n${credential}`),
    credential,
    issueCode: "MAX_DEPTH_EXCEEDED",
  },
  {
    label: "escaped-whitespace duplicate decoded key",
    source: String.raw`{"Bearer\tSYNTHETIC_REVIEW_TOKEN":{},"Bearer\u0009SYNTHETIC_REVIEW_TOKEN":{}}`,
    credential,
    issueCode: "DUPLICATE_JSON_KEY",
  },
  {
    label: "duplicate-shadowed opaque key underflow",
    source: '{"x":{"OPAQUE_SYNTHETIC_PRIVATE_VALUE":1e-999},"x":{}}',
    credential: "OPAQUE_SYNTHETIC_PRIVATE_VALUE",
    issueCode: "INVALID_JSON",
  },
] as const;
