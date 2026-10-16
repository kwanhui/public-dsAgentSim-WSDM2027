// Data requests that scripts send to the data owner. The
// platform releases a file only when the learner's own messages in the data
// owner's channel name at least one column of the file's data dictionary and
// state a purpose (lib/agents/release-scope.ts). A request that names only
// broad groups ("attributes, usage, billing") is withheld with an in-role
// question, so every scripted request names columns.
// tests/unit/script-data-requests.test.ts runs each one through the check.

export const CAPTURE_PANEL_DATA_REQUEST =
  "Hi Marcus. For the agreed retention-targeting scope I need subscriber_id, tenure, contract type, data usage, total charges, late payments and the churn label for postpaid subscribers, one row per subscriber. Purpose: to rank subscribers by churn risk for the monthly retention call list. Can you release the extract?";
