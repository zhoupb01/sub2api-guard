export type Settings = {
  windowMinutes: number;
  minRequests: number;
  errorRate: number;
  cooldownMinutes: number;
  healthyMinutes: number;
  healthyRate: number;
  minSchedulable: number;
  reopenMinutes: number;
  maxConcurrency: number;
  maxOverrides: Record<string, number>;
  priorityStep: number;
  errorPatterns: string[];
  tickSeconds: number;
  barkUrl: string;
  probeGroupName: string;
};

export const defaultSettings: Settings = {
  windowMinutes: 10,
  minRequests: 20,
  errorRate: 0.05,
  cooldownMinutes: 10,
  healthyMinutes: 30,
  healthyRate: 0.01,
  minSchedulable: 4,
  reopenMinutes: 720,
  maxConcurrency: 3,
  maxOverrides: {},
  priorityStep: 1,
  errorPatterns: ["overloaded", "Concurrency limit exceeded for account"],
  tickSeconds: 60,
  barkUrl: "",
  probeGroupName: "账号测试",
};

export function maxConcurrencyFor(settings: Settings, id: number) {
  return settings.maxOverrides[id] ?? settings.maxConcurrency;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const nonnegativeInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const positiveInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1;
const rate = (value: unknown) => typeof value === "number" && value > 0 && value <= 1;

function isBarkUrl(value: unknown) {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

const validators: Record<keyof Settings, (value: unknown) => boolean> = {
  windowMinutes: positiveInteger,
  minRequests: positiveInteger,
  errorRate: rate,
  cooldownMinutes: positiveInteger,
  healthyMinutes: positiveInteger,
  healthyRate: rate,
  minSchedulable: nonnegativeInteger,
  reopenMinutes: positiveInteger,
  maxConcurrency: positiveInteger,
  maxOverrides: (value) => isObject(value) && Object.entries(value).every(([id, max]) => /^\d+$/.test(id) && positiveInteger(max)),
  priorityStep: nonnegativeInteger,
  errorPatterns: (value) => Array.isArray(value) && value.length > 0 && value.every((pattern) => typeof pattern === "string" && pattern.trim() !== ""),
  tickSeconds: (value) => typeof value === "number" && Number.isInteger(value) && value >= 10 && value <= 3_600,
  barkUrl: isBarkUrl,
  probeGroupName: (value) => typeof value === "string" && value.trim() !== "",
};

export function isSettings(value: unknown): value is Settings {
  const fields = Object.entries(validators);
  return isObject(value) && Object.keys(value).length === fields.length &&
    fields.every(([field, validate]) => Object.hasOwn(value, field) && validate(value[field]));
}
