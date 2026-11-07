// Generated from schemas/K01/v1.schema.json by tools/contracts/generate.mjs; do not edit.
export const K01_KEY = "K01.project.subtitle_text.replace.v1";
export const K01_RULES = {
  "version": 1,
  "versionMaximum": 9007199254740991,
  "command": "project.subtitle_text.replace",
  "subjectType": "project",
  "revisionMinimum": 1,
  "revisionMaximum": 9007199254740990,
  "uuidLength": 36,
  "uuidPattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "textMinimum": 1,
  "textMaximum": 500,
  "textPattern": "^[^\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]+$(?![\\s\\S])",
  "rootFields": [
    "schemaVersion",
    "commandName",
    "commandId",
    "idempotencyKey",
    "subjectRef",
    "expectedRevision",
    "payload"
  ],
  "subjectFields": [
    "type",
    "id"
  ],
  "payloadFields": [
    "subtitleId",
    "text"
  ],
  "forbiddenFields": [
    "actorUserId",
    "authorizationContextRef",
    "ownerUserId",
    "groupId",
    "externalAccountKey",
    "requestId",
    "traceId",
    "occurredAt",
    "jobId",
    "attemptId",
    "eventName",
    "eventId"
  ],
  "digestDomain": "orange:k01:project.subtitle_text.replace:v1",
  "invalidCode": "CONTRACT_INVALID",
  "unsupportedCode": "UNSUPPORTED_VERSION"
} as const;
export type K01Record = {
  readonly schemaVersion: 1;
  readonly commandName: "project.subtitle_text.replace";
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly subjectRef: {
    readonly type: "project";
    readonly id: string;
  };
  readonly expectedRevision: number;
  readonly payload: {
    readonly subtitleId: string;
    readonly text: string;
  };
};
export type K01SaveResult = {
  readonly commandId: string;
  readonly projectRevisionId: string;
  readonly revision: number;
};
