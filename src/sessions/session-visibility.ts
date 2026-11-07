import { TENANT } from "./items.ts";

export const participantItemWindow = (item: string, participant: string): string =>
  `((${participant}.valid_from_seq IS NOT NULL AND ${item}.seq >= ${participant}.valid_from_seq)
    OR (${participant}.valid_from_seq IS NULL AND ${item}.created_at >= to_timestamp(${participant}.valid_from::double precision / 1000)))
   AND ((${participant}.valid_to_seq IS NOT NULL AND ${item}.seq < ${participant}.valid_to_seq)
    OR (${participant}.valid_to_seq IS NULL AND (${participant}.valid_to IS NULL OR ${item}.created_at < to_timestamp(${participant}.valid_to::double precision / 1000))))`;

export const participantHasItems = (session: string, participant: string): string =>
  `EXISTS (SELECT 1 FROM items visible WHERE visible.tenant_id = ${TENANT} AND visible.session_id = ${session}.id AND ${participantItemWindow("visible", participant)})`;
