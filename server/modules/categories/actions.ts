// categories.create / update / toggleArchive / delete
// (lib/features/categories/application/category_actions.dart).

import { sql } from 'kysely';
import { z } from 'zod';
import { zBool, zEnum, zId, zText, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { categoryFromRow, type Category } from '../../finance/models';

export const CATEGORY_COLOR_COUNT = 14;
const NAME_MIN = 2;
const NAME_MAX = 30;
const DESCRIPTION_MAX = 120;

const dataShape = {
  name: zText,
  type: zEnum(['income', 'expense'] as const),
  iconKey: zText,
  colorIndex: z.number().int(),
  description: zTextOpt.transform((v) => v ?? ''),
  isEssential: zBool(false),
};
const categoryInput = z.object(dataShape);
type CategoryInput = z.output<typeof categoryInput>;

const fields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Category name, 2–30 characters, unique per type', required: true },
  { name: 'type', kind: 'enumeration', description: 'income or expense', required: true, allowedValues: ['income', 'expense'] },
  { name: 'iconKey', kind: 'string', description: 'Icon key, e.g. utensils', required: true },
  { name: 'colorIndex', kind: 'integer', description: 'Colour swatch index, 0–13', required: true },
  { name: 'description', kind: 'string', description: 'What belongs here', required: false },
  { name: 'isEssential', kind: 'boolean', description: 'Essential spending (used for the emergency-fund suggestion)', required: false },
];

const typeLabel = (t: 'income' | 'expense') => (t === 'income' ? 'income' : 'expense');
const withArticle = (word: string) => `${'aeiou'.includes(word[0]!) ? 'an' : 'a'} ${word}`;

export interface CategoryUsage {
  transactions: number;
  budgets: number;
  subscriptions: number;
}

export async function categoryUsage(ctx: ActionContext, categoryId: string): Promise<CategoryUsage> {
  const r = await sql<{ t: string; b: string; s: string }>`
    select (select count(*) from public.transactions where user_id = ${ctx.userId} and category_id = ${categoryId}) as t,
           (select count(*) from public.budgets where user_id = ${ctx.userId} and category_id = ${categoryId}) as b,
           (select count(*) from public.subscriptions where user_id = ${ctx.userId} and category_id = ${categoryId}) as s`.execute(ctx.tx);
  const row = r.rows[0]!;
  return { transactions: Number(row.t), budgets: Number(row.b), subscriptions: Number(row.s) };
}

const inUse = (u: CategoryUsage) => u.transactions > 0 || u.budgets > 0 || u.subscriptions > 0;

/** "12 transactions, 1 budget". */
export function describeUsage(u: CategoryUsage): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [
    u.transactions > 0 ? n(u.transactions, 'transaction') : null,
    u.budgets > 0 ? n(u.budgets, 'budget') : null,
    u.subscriptions > 0 ? n(u.subscriptions, 'subscription') : null,
  ]
    .filter(Boolean)
    .join(', ');
}

async function validateCategory(i: CategoryInput, ctx: ActionContext, selfId?: string): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  const name = i.name.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.name = `Use ${NAME_MIN} to ${NAME_MAX} characters.`;
  } else {
    const clash = (await ctx.snapshot.categories()).find(
      (c) => c.id !== selfId && c.type === i.type && c.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      errors.name = clash.isArchived
        ? `An archived ${typeLabel(i.type)} category is called "${clash.name}". Restore it instead.`
        : `You already have ${withArticle(typeLabel(i.type))} category called "${clash.name}".`;
    }
  }
  if (i.iconKey.trim() === '') errors.iconKey = 'Choose an icon.';
  if (i.colorIndex < 0 || i.colorIndex >= CATEGORY_COLOR_COUNT) errors.colorIndex = 'Choose a colour.';
  if (i.description.length > DESCRIPTION_MAX) errors.description = `Keep this under ${DESCRIPTION_MAX} characters.`;
  return errors;
}

const lines = (i: CategoryInput): PreviewLine[] => [
  { label: 'Name', value: i.name.trim() },
  { label: 'Type', value: i.type === 'income' ? 'Income' : 'Expense' },
  ...(i.type === 'expense' ? [{ label: 'Essential', value: i.isEssential ? 'Yes' : 'No' }] : []),
];

async function save(ctx: ActionContext, c: Category, expectedVersion?: number): Promise<Category> {
  const now = ctx.now.toISOString();
  const values = {
    name: c.name,
    type: c.type,
    icon_key: c.iconKey,
    color_index: c.colorIndex,
    description: c.description,
    is_system: c.isSystem,
    is_archived: c.isArchived,
    is_essential: c.isEssential,
    version: c.version,
    updated_at: now,
  };
  if (expectedVersion === undefined) {
    const row = await ctx.tx
      .insertInto('categories')
      .values({ user_id: ctx.userId, id: c.id, created_at: now, ...values })
      .returningAll()
      .executeTakeFirstOrThrow();
    return categoryFromRow(row);
  }
  const row = await ctx.tx
    .updateTable('categories')
    .set(values)
    .where('user_id', '=', ctx.userId)
    .where('id', '=', c.id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This category changed since you opened it. Reload and try again.');
  return categoryFromRow(row);
}

async function existing(ctx: ActionContext, id: string): Promise<Category> {
  const c = await ctx.snapshot.category(id);
  if (!c) throw AppFailure.notFound('This category no longer exists.');
  return c;
}

export const createCategory = defineAction({
  descriptor: {
    id: 'categories.create',
    module: 'categories',
    title: 'Create a category',
    description: 'Adds a custom income or expense category. Does not move money.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields,
  },
  input: categoryInput,
  async prepare(input, ctx) {
    throwIfErrors(await validateCategory(input, ctx));
    return { title: 'Create category', summary: `Category "${input.name.trim()}" created`, lines: lines(input) };
  },
  async execute(input, ctx) {
    const c = await save(ctx, {
      id: ctx.ids.next('cat'),
      name: input.name.trim(),
      type: input.type,
      iconKey: input.iconKey,
      colorIndex: input.colorIndex,
      description: input.description.trim(),
      isSystem: false,
      isArchived: false,
      isEssential: input.type === 'expense' && input.isEssential,
      version: 1,
    });
    ctx.touched.push(c.id);
    return c;
  },
});

export const updateCategory = defineAction({
  descriptor: {
    id: 'categories.update',
    module: 'categories',
    title: 'Edit a category',
    description: 'Renames or restyles a category. System categories only allow icon and colour changes.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Category id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...fields,
    ],
  },
  input: z.object({ id: zId, expectedVersion: zVersion, ...dataShape }),
  async prepare(input, ctx) {
    const c = await existing(ctx, input.id);
    if (c.version !== input.expectedVersion) throw AppFailure.stale('This category changed since you opened it. Reload and try again.');
    if (c.isSystem) {
      const changed =
        input.name.trim() !== c.name || input.type !== c.type || input.description.trim() !== c.description || input.isEssential !== c.isEssential;
      if (changed) throw AppFailure.notPermitted('This category is managed automatically. Only its icon and colour can change.');
    }
    const errors = await validateCategory(input, ctx, c.id);
    if (input.type !== c.type) {
      const usage = await categoryUsage(ctx, c.id);
      if (inUse(usage)) errors.type = `This category is used by ${describeUsage(usage)}, so its type cannot change.`;
    }
    throwIfErrors(errors);
    return { title: 'Save changes', summary: `Category "${input.name.trim()}" updated`, lines: lines(input) };
  },
  async execute(input, ctx) {
    const c = await existing(ctx, input.id);
    const updated = await save(
      ctx,
      {
        ...c,
        name: input.name.trim(),
        type: input.type,
        iconKey: input.iconKey,
        colorIndex: input.colorIndex,
        description: input.description.trim(),
        isEssential: input.type === 'expense' && input.isEssential,
        version: c.version + 1,
      },
      c.version,
    );
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const toggleArchiveCategory = defineAction({
  descriptor: {
    id: 'categories.toggleArchive',
    module: 'categories',
    title: 'Archive or restore a category',
    description: 'Hides a category from pickers (or restores it). Past transactions keep their category.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [{ name: 'id', kind: 'id', description: 'Category id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const c = await existing(ctx, input.id);
    if (c.isSystem) throw AppFailure.notPermitted('System categories are always available and cannot be archived.');
    const archiving = !c.isArchived;
    const warnings: string[] = [];
    if (archiving) {
      const budgets = (await ctx.snapshot.budgets()).filter((b) => b.categoryId === c.id).length;
      const subs = (await ctx.snapshot.subscriptions()).filter((x) => x.categoryId === c.id && x.status === 'active').length;
      if (budgets > 0) warnings.push(`${budgets} budget${budgets === 1 ? '' : 's'} still track${budgets === 1 ? 's' : ''} this category.`);
      if (subs > 0) warnings.push(`${subs} active subscription${subs === 1 ? '' : 's'} still use this category.`);
    }
    return {
      title: archiving ? `Archive ${c.name}?` : `Restore ${c.name}?`,
      summary: archiving ? `${c.name} archived` : `${c.name} restored`,
      warnings,
      basis: { v: c.version },
    };
  },
  async execute(input, ctx) {
    const c = await existing(ctx, input.id);
    const updated = await save(ctx, { ...c, isArchived: !c.isArchived, version: c.version + 1 }, c.version);
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteCategory = defineAction({
  descriptor: {
    id: 'categories.delete',
    module: 'categories',
    title: 'Delete a category',
    description: 'Permanently removes a category that no transaction, budget or subscription uses.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Category id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const c = await existing(ctx, input.id);
    if (c.isSystem) throw AppFailure.notPermitted('System categories cannot be deleted.');
    const usage = await categoryUsage(ctx, c.id);
    if (inUse(usage)) throw AppFailure.conflict(`${c.name} is used by ${describeUsage(usage)}. Archive it instead to hide it from pickers.`);
    return {
      title: `Delete ${c.name}?`,
      summary: `${c.name} deleted`,
      lines: [{ label: 'Type', value: c.type === 'income' ? 'Income' : 'Expense' }],
      warnings: ['This cannot be undone.'],
      basis: { v: c.version },
    };
  },
  async execute(input, ctx) {
    const c = await existing(ctx, input.id);
    await ctx.tx.deleteFrom('categories').where('user_id', '=', ctx.userId).where('id', '=', c.id).execute();
    ctx.touched.push(c.id);
    return c;
  },
});

export const categoriesActions: AnyAction[] = [createCategory, updateCategory, toggleArchiveCategory, deleteCategory] as AnyAction[];
