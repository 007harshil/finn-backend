import type { AssetType } from '../../finance/models';

/** AssetType.label in the Flutter app. */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  bankDeposit: 'Bank & FD',
  investment: 'Investments',
  retirement: 'Retirement (EPF/PPF/NPS)',
  gold: 'Gold & jewellery',
  property: 'Property',
  vehicle: 'Vehicle',
  other: 'Other',
};
