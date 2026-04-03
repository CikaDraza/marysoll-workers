import { Types } from "mongoose";

// ---------------------------------------------------------------------------
// BullMQ job payload
// ---------------------------------------------------------------------------

export interface CampaignJobData {
  campaignId: string;
}

export interface SendCampaignParams {
  campaignId: string;
}

// ---------------------------------------------------------------------------
// A/B test
// ---------------------------------------------------------------------------

export interface AbTestVariant {
  /** Subject line for this variant. */
  subject: string;
  /** Relative weight (0–100). All variants should sum to 100. */
  weight: number;
}

export interface AbTestConfig {
  enabled: boolean;
  variants: AbTestVariant[];
}

// ---------------------------------------------------------------------------
// EmailCampaign document
// Mirrors the SaaS EmailCampaign Mongoose schema (strict:false allows lean reads).
// Fields match the actual MongoDB document shape — all nested sub-documents
// are explicitly typed so the worker never guesses field names.
// ---------------------------------------------------------------------------

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed";

export interface CampaignContent {
  subject: string;
  previewText?: string;
  heroTitle?: string;
  heroText?: string;
  offerTitle?: string;
  offerText?: string;
  ctaText?: string;
  ctaUrl?: string;
}

export interface CampaignTemplate {
  templateId?: string;
  /** Rendered HTML to send to each recipient. */
  html: string;
}

export interface CampaignScheduling {
  status: CampaignStatus;
  sendAt?: Date;
  sentAt?: Date;
}

export interface CampaignMetrics {
  recipients: number;
  opens: number;
  clicks: number;
  openRate: number;
  clickRate: number;
}

export interface CampaignOptimization {
  predictedOpenRate: number;
  predictedClickRate: number;
  optimizedSubject?: string;
  confidenceScore?: number;
}

export interface CampaignDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  salonProfileId: Types.ObjectId;
  salonName: string;

  topic: string;
  audience?: string;
  tone?: string;

  content: CampaignContent;
  template: CampaignTemplate;
  scheduling: CampaignScheduling;
  metrics: CampaignMetrics;
  optimization: CampaignOptimization;
  abTest: AbTestConfig;
}

// ---------------------------------------------------------------------------
// Subscriber — pulled from the SaaS User collection
// ---------------------------------------------------------------------------

export interface Subscriber {
  _id: Types.ObjectId;
  email: string;
  name?: string;
  tenantId: Types.ObjectId | null;
  newsletterPreferences?: {
    subscribed: boolean;
    emailVerified: boolean;
    unsubscribeToken?: string;
    lastEmailSent?: Date;
  };
  notificationSettings?: {
    newsletterPromotions: boolean;
    newsletterUpdates: boolean;
    newsletterTips: boolean;
  };
}

// ---------------------------------------------------------------------------
// CampaignAnalytics document
// Mirrors SaaS CampaignAnalytics schema. One document per (tenantId, salonProfileId).
// ---------------------------------------------------------------------------

export interface EmailCampaignPerformance {
  campaignId: string;
  subjectLine: string;
  topic?: string;
  sentCount: number;
  deliveredCount: number;
  openCount: number;
  clickCount: number;
  openRate: number;
  clickRate: number;
  createdAt: Date;
}

export interface CampaignAnalyticsDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  salonProfileId: Types.ObjectId;
  totalCampaigns: number;
  avgOpenRate: number;
  avgClickRate: number;
  bestSubjectLines: string[];
  worstSubjectLines: string[];
  topTopics: string[];
  campaignHistory: EmailCampaignPerformance[];
  lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// Internal API send-email payload
// POST ${INTERNAL_API_URL}/internal/send-email
// ---------------------------------------------------------------------------

export interface SendEmailPayload {
  /** Recipient email address. */
  to: string;
  /** Subject line (may differ per subscriber for A/B test). */
  subject: string;
  /** Fully-rendered HTML body. */
  html: string;
  /** Campaign ID for tracking pixel / click attribution. */
  campaignId: string;
  /** Subscriber (User) ID for tracking. */
  subscriberId: string;
  /** Tenant ID — enforced on the SaaS side as well for isolation. */
  tenantId: string;
}
