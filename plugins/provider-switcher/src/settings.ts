import type { SettingSchema } from "@t3p/api";

/** Settings rendered on the Plugins settings page. */
export const SETTINGS: SettingSchema[] = [
  {
    key: "favourites",
    type: "string",
    default: "",
    label: "Favourite models",
    description:
      "One `instanceId:model` per line, for example `claudeAgent:claude-sonnet-5-5`. Each line becomes a \"Switch to …\" command in the palette.",
  },
  {
    key: "suggestOnLimit",
    type: "boolean",
    default: false,
    label: "Suggest a switch near a usage limit",
    description:
      "When the focused thread's provider passes the threshold below, offer to switch it to the least-used usable provider. At most once per thread per crossing.",
  },
  {
    key: "limitThreshold",
    type: "number",
    default: 90,
    min: 1,
    max: 100,
    label: "Suggestion threshold (percent)",
    description: "The provider's worst usage window has to reach this percent before a switch is suggested.",
  },
];
