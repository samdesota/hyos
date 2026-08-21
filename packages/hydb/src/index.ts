import { schemaBuilders } from "./schema.js";
import { query } from "./query.js";

export {
  boolean,
  id,
  index,
  integer,
  json,
  number,
  text,
  timestamp,
  uniqueIndex,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from "./schema.js";

export { type InferQueryResult, type Query } from "./query.js";

export const hydb = {
  ...schemaBuilders,
  query,
};
