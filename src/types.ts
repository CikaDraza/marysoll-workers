import { Types } from "mongoose";

// ---------- Job ----------

export interface CampaignJobData {
  campaignId: string;
}

export interface SendCampaignParams {
  campaignId: string;
}

// ---------- Campaign ----------

export type CampaignStatus = "scheduled" | "sending" | "sent" | "failed";

export interface AbTestVariant {
  subject: string;
  weight: number; // 0–100, must sum to 100 across variants
}

export interface AbTestConfig {
  enabled: boolean;
  variants: AbTestVariant[];
}

export interface CampaignDocument {
  _id: Types.ObjectId;
  salonProfileId: Types.ObjectId;
  tenantId: Types.ObjectId;
  subject: string;
  previewText?: string;
  htmlContent: string;
  ctaLink?: string;
  status: CampaignStatus;
  sentAt?: Date;
  recipientsCount?: number;
  topic?: string;
  abTest?: AbTestConfig;
}

// ---------- Subscriber ----------

export interface Subscriber {
  _id: Types.ObjectId;
  email: string;
  salonProfileId: Types.ObjectId;
  tenantId: Types.ObjectId;
  isSubscribed: boolean;
}

// ---------- Analytics ----------

export interface CampaignHistoryEntry {
  campaignId: Types.ObjectId;
  sentAt: Date;
  recipients: number;
  topic?: string;
}

export interface CampaignAnalyticsDocument {
  _id: Types.ObjectId;
  salonProfileId: Types.ObjectId;
  tenantId: Types.ObjectId;
  recipients: number;
  openRate: number;
  clickRate: number;
  topic?: string;
  sendTime?: Date;
  campaignHistory: CampaignHistoryEntry[];
}

// ---------- Email payload ----------

export interface SendEmailPayload {
  to: string;
  subject: string;
  html: string;
  campaignId: string;
  subscriberId: string;
}
