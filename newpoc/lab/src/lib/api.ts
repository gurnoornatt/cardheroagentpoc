import axios from "axios";

const http = axios.create({ baseURL: "/api" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Health {
  status: string;
  db: string;
  daily_spend_today: number;
  budget_remaining: number;
  daily_spend_limit: number;
  agent_budget: number;
}

export interface WantListItem {
  id: number;
  name: string;
  grade: string;
  max_price: number;
  cert_prefix: string | null;
  target_id: string | null;
  set_name: string | null;
  year: number | null;
  is_active: boolean;
  sanitized_avg: number | null;
  created_at: string | null;
}

export interface Deal {
  id: number;
  want_list_id: number;
  url: string;
  listing_type: string;
  price: number;
  shipping: number;
  tax_estimate: number;
  landed_cost: number;
  status: "PENDING" | "ANALYZING" | "BOUGHT" | "REJECTED";
  watchman_score: number | null;
  sentiment_score: number | null;
  sentiment_weight: number | null;
  undervalue_delta: number | null;
  seller_username: string | null;
  seller_rating: number | null;
  seller_feedback_count: number | null;
  ebay_item_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  audit_log?: AuditLog | null;
}

export interface AuditLog {
  id: number;
  agent_extraction_json: string | null;
  psa_pop_grade10: number | null;
  psa_pop_total: number | null;
  screenshot_path: string | null;
  dom_snapshot_path: string | null;
  verified_cert: string | null;
  price_locked: number | null;
  authenticity_guaranteed: boolean | null;
  session_id: string | null;
  model_used: string | null;
  extraction_latency_ms: number | null;
  created_at: string | null;
}

export interface PortfolioItem {
  id: number;
  name: string;
  grade: string;
  purchase_price: number;
  current_value: number;
  cert_number: string;
  purchase_date: string | null;
  set_name: string | null;
  year: number | null;
  notes: string | null;
  unrealized_pnl: number;
  pnl_pct: number;
}

export interface LabRun {
  id: number;
  deal_id: number;
  model: string;
  extracted_cert: string | null;
  extracted_price: number | null;
  extracted_pop_grade10: number | null;
  extracted_pop_total: number | null;
  ground_truth_cert: string | null;
  cert_correct: boolean | null;
  price_correct: boolean | null;
  latency_ms: number | null;
  created_at: string | null;
}

export interface LabMetrics {
  [model: string]: {
    run_count: number;
    cert_accuracy: number | null;
    avg_latency_ms: number | null;
  };
}

export interface ScraperSample {
  title: string;
  price: number;
  shipping: number;
  url: string;
}

export interface ScraperStats {
  count: number;
  time_ms: number;
  price_min: number | null;
  price_max: number | null;
  price_avg: number | null;
  samples: ScraperSample[];
}

export interface ScraperCompareResult {
  query: string;
  search_url: string;
  html: ScraperStats;
  apify: ScraperStats;
}

export interface DealHuntResult {
  platform: string;
  title: string;
  price: number;
  shipping: number;
  landed_cost: number;
  url: string;
  image_url: string;
  seller_username: string;
  seller_rating: number;
  seller_feedback_count: number;
  watchman_score: number;
  filter_passed: boolean;
  filter_reason: string;
}

export interface DealHuntResponse {
  results: DealHuntResult[];
  total: number;
  filtered_count: number;
  platforms_queried: string[];
}

export interface CollectrWantListAddition {
  want_list_id: number;
  name: string;
  grade: string;
  max_price: number;
  set_name: string | null;
  is_active: boolean;
}

export interface CollectrJobStartResponse {
  job_id: string;
}

export interface CollectrJobStatusResponse {
  status: "running" | "done" | "error";
  session_url: string | null;
  result: CollectrImportResponse | null;
  error: string | null;
}

export interface CollectrImportResponse {
  cards_found: number;
  imported_count: number;
  skipped_count: number;
  want_list_additions: CollectrWantListAddition[];
  skipped_details: Array<{ card: object; reason: string }>;
}

export interface VoiceSession {
  client_secret: { value: string } | null;
  expires_at: number | null;
}

export interface WatchmanStatus {
  status: "running" | "offline" | "blocked";
  last_scan_at: string | null;
  items_scanned: number;
  error: string | null;
}

export interface WantListCreatePayload {
  name: string;
  grade: string;
  max_price: number;
  set_name?: string;
  year?: number;
  cert_prefix?: string;
}

// ─── API functions ────────────────────────────────────────────────────────────

export const api = {
  health: () => http.get<Health>("/health").then((r) => r.data),
  wantList: () => http.get<WantListItem[]>("/want-list").then((r) => r.data),
  addWantListItem: (body: WantListCreatePayload) =>
    http.post<WantListItem>("/want-list", body).then((r) => r.data),
  watchmanStatus: () => http.get<WatchmanStatus>("/watchman/status").then((r) => r.data),
  portfolio: () => http.get<PortfolioItem[]>("/portfolio").then((r) => r.data),
  deals: (status?: string) =>
    http
      .get<Deal[]>("/deals", { params: status ? { status } : {} })
      .then((r) => r.data),
  deal: (id: number) => http.get<Deal>(`/deals/${id}`).then((r) => r.data),
  patchDealStatus: (id: number, status: string) =>
    http.patch(`/deals/${id}/status`, { status }).then((r) => r.data),
  labRuns: () => http.get<LabRun[]>("/lab/runs").then((r) => r.data),
  labMetrics: () => http.get<LabMetrics>("/lab/metrics").then((r) => r.data),
  runExtraction: (deal_id: number, model: string, ground_truth_cert?: string) =>
    http
      .post<LabRun>("/lab/extract", { deal_id, model, ground_truth_cert })
      .then((r) => r.data),
  runPipeline: (url: string, max_price: number) =>
    http
      .post<{ deal_id: number; status: string }>("/pipeline/run", { url, max_price, dry_run: true })
      .then((r) => r.data),
  dealLogs: (deal_id: number) =>
    http.get<{ logs: string[] }>(`/deals/${deal_id}/logs`).then((r) => r.data.logs),
  scraperCompare: (query: string) =>
    http.post<ScraperCompareResult>("/scraper-compare", { query }).then((r) => r.data),
  dealHunt: (card_name: string, grade: string, max_price: number, platforms: string[]) =>
    http
      .post<DealHuntResponse>("/tools/deal-hunt", { card_name, grade, max_price, platforms })
      .then((r) => r.data),
  collectrImport: (showcase_url: string) =>
    http
      .post<CollectrJobStartResponse>("/integrations/collectr/import", { showcase_url })
      .then((r) => r.data),
  collectrJobStatus: (job_id: string) =>
    http
      .get<CollectrJobStatusResponse>(`/integrations/collectr/job/${job_id}`)
      .then((r) => r.data),
  voiceSession: () => http.get<VoiceSession>("/voice/session").then((r) => r.data),
};
