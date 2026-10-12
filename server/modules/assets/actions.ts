// assets.create / update / delete (lib/features/net_worth/application/asset_actions.dart).

import { z } from 'zod';
import { zDate, zEnum, zId, zMoney, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { ASSET_TYPES, type Asset } from '../../finance/models';
import { ASSET_TYPE_LABELS } from './labels';
import { deleteAsset, insertAsset, updateAsset } from './repo';

/** Largest single valuation accepted (₹1,000 crore): guards against typos. */
export const MAX_ASSET_PAISE = 10_000_000_000 * 100;

const dataShape = {
  name: z.string(),
  type: zEnum(ASSET_TYPES),
  value: zMoney,
  valuedOn: zDate,
  note: zTextOpt,
};
const assetInput = z.object(dataShape);
type AssetInput = z.output<typeof assetInput>;

const fields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Asset name, 2–40 characters', required: true },
  { name: 'type', kind: 'enumeration', description: 'Kind of asset', required: true, allowedValues: ASSET_TYPES },
  { name: 'value', kind: 'money', description: 'Estimated current value in rupees (zero or more)', required: true },
  { name: 'valuedOn', kind: 'date', description: 'Date of the valuation (not in the future)', required: true },
  { name: 'note', kind: 'string', description: 'Free-text note', required: false },
];

export function validateAsset(i: AssetInput, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = i.name.trim();
  if (name.length < 2) errors.name = 'Use at least 2 characters.';
  else if (name.length > 40) errors.name = 'Keep the name under 40 characters.';
  if (i.value > MAX_ASSET_PAISE) errors.value = 'That value looks too large. Please check it.';
  if (i.valuedOn > today) errors.valuedOn = 'The valuation date cannot be in the future.';
  if ((i.note?.length ?? 0) > 500) errors.note = 'Keep the note under 500 characters.';
  return errors;
}

const lines = (i: AssetInput): PreviewLine[] => [
  { label: 'Asset', value: i.name.trim() },
  { label: 'Type', value: ASSET_TYPE_LABELS[i.type] },
  { label: 'Value', value: formatInr(i.value), emphasis: true },
  { label: 'Valued on', value: formatDate(i.valuedOn) },
];

const signed = (paise: number) => `${paise >= 0 ? '+' : '-'}${formatInr(Math.abs(paise))}`;

export const createAsset = defineAction({
  descriptor: {
    id: 'assets.create',
    module: 'net_worth',
    title: 'Add an asset',
    description: 'Adds an estimated asset value (investments, gold, property…) to net worth. Does not change the cash balance.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields,
  },
  input: assetInput,
  async prepare(input, ctx) {
    throwIfErrors(validateAsset(input, ctx.today));
    const name = input.name.trim();
    const warnings: string[] = [];
    if ((await ctx.snapshot.assets()).some((a) => a.name.trim().toLowerCase() === name.toLowerCase())) {
      warnings.push(`You already have an asset called "${name}".`);
    }
    return { title: 'Add asset', summary: `Added ${name} at ${formatInr(input.value)}`, lines: lines(input), warnings };
  },
  async execute(input, ctx): Promise<Asset> {
    const now = ctx.now.toISOString();
    const a = await insertAsset(ctx.tx, ctx.userId, {
      id: ctx.ids.next('asset'),
      name: input.name.trim(),
      type: input.type,
      valuePaise: input.value,
      valuedOn: input.valuedOn,
      note: input.note,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    ctx.touched.push(a.id);
    return a;
  },
});

async function existingAsset(id: string, ctx: ActionContext): Promise<Asset> {
  const a = (await ctx.snapshot.assets()).find((x) => x.id === id);
  if (!a) throw AppFailure.notFound('This asset no longer exists.');
  return a;
}

export const updateAssetAction = defineAction({
  descriptor: {
    id: 'assets.update',
    module: 'net_worth',
    title: 'Update an asset',
    description: "Changes an asset's name, type or estimated value. Net worth updates automatically.",
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Asset id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...fields,
    ],
  },
  input: z.object({ id: zId, expectedVersion: zVersion, ...dataShape }),
  async prepare(input, ctx) {
    const existing = await existingAsset(input.id, ctx);
    if (existing.version !== input.expectedVersion) {
      throw AppFailure.stale('This asset changed since you opened it. Reload and try again.');
    }
    throwIfErrors(validateAsset(input, ctx.today));
    const change = input.value - existing.valuePaise;
    const name = input.name.trim();
    return {
      title: 'Save changes',
      summary: change === 0 ? `Updated ${name}` : `Updated ${name} to ${formatInr(input.value)}`,
      lines: [...lines(input), ...(change !== 0 ? [{ label: 'Net worth effect', value: signed(change) }] : [])],
    };
  },
  async execute(input, ctx) {
    const existing = await existingAsset(input.id, ctx);
    const updated = await updateAsset(
      ctx.tx,
      ctx.userId,
      {
        ...existing,
        name: input.name.trim(),
        type: input.type,
        valuePaise: input.value,
        valuedOn: input.valuedOn,
        note: input.note,
        updatedAt: ctx.now.toISOString(),
        version: existing.version + 1,
      },
      input.expectedVersion,
    );
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteAssetAction = defineAction({
  descriptor: {
    id: 'assets.delete',
    module: 'net_worth',
    title: 'Delete an asset',
    description: 'Removes an asset valuation. Net worth goes down by its value. Cash is not affected.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Asset id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const a = await existingAsset(input.id, ctx);
    return {
      title: 'Delete asset?',
      summary: `Deleted ${a.name}`,
      lines: [
        { label: 'Type', value: ASSET_TYPE_LABELS[a.type] },
        { label: 'Net worth effect', value: signed(-a.valuePaise), emphasis: true },
      ],
      warnings: ['This cannot be undone. Your cash balance is not affected.'],
      basis: { version: a.version },
    };
  },
  async execute(input, ctx) {
    const a = await existingAsset(input.id, ctx);
    await deleteAsset(ctx.tx, ctx.userId, a.id);
    ctx.touched.push(a.id);
    return a;
  },
});

export const assetsActions: AnyAction[] = [createAsset, updateAssetAction, deleteAssetAction] as AnyAction[];
