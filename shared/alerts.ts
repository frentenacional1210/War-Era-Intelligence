export const alertThemes = ['military', 'territory', 'politics', 'economy', 'community', 'activity', 'media'] as const;
export const alertSeverities = ['info', 'notable', 'high'] as const;
export type AlertTheme = typeof alertThemes[number];
export type AlertSeverity = typeof alertSeverities[number];
export type AlertFeedItem = {
  id: string; title: string; theme: AlertTheme; severity: AlertSeverity;
  observedAt: string; countryId: string | null; sourceUrl: string;
  entityType: string; entityId: string; explanation: string; verification: string;
  before: unknown; after: unknown; rule: string;
};
export const isAlertTheme = (value: unknown): value is AlertTheme => alertThemes.some(theme => theme === value);
export const isAlertSeverity = (value: unknown): value is AlertSeverity => alertSeverities.some(severity => severity === value);
export const validAlertId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const validAlertTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
