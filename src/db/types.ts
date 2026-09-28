// Core domain types for the service portal.

export type ProductCategory =
  | 'Residential AC'
  | 'Commercial AC'
  | 'VRF / VRV'
  | 'Chiller'
  | 'Refrigerator'
  | 'Chest Freezer'
  | 'Washing Machine'
  | 'Television'
  | 'Gas Cooker'
  | 'Microwave'
  | 'Other';

export type CapacityUnit = 'BTU/h' | 'TR' | 'kW' | 'HP' | 'L';

export type Refrigerant = 'R22' | 'R134a' | 'R410A' | 'R32' | 'R600a' | 'R290' | 'R407C' | 'None';

/** Refrigerants in the order shown in pickers (main ones first). */
export const REFRIGERANTS: Exclude<Refrigerant, 'None'>[] = ['R22', 'R134a', 'R410A', 'R32', 'R600a', 'R290', 'R407C'];

export type ComplaintStatus =
  | 'Registered'
  | 'Assigned'
  | 'In Progress'
  | 'Awaiting Parts'
  | 'Resolved'
  | 'Closed'
  | 'Cancelled';

export type Priority = 'Low' | 'Normal' | 'High' | 'Critical';

export type JobType =
  | 'Inspection / Diagnosis'
  | 'New Installation'
  | 'Re-installation / Shifting'
  | 'Gas Top-up'
  | 'Leak Repair + Full Recharge'
  | 'Compressor Replacement'
  | 'Coil / Pipe Replacement'
  | 'PCB / Electrical Repair'
  | 'Mechanical Repair'
  | 'Preventive Maintenance'
  | 'Other';

export type WarrantyStatus = 'In Warranty' | 'Out of Warranty' | 'AMC' | 'Unknown';

export interface Customer {
  id: string;
  name: string;
  phone: string;
  altPhone?: string;
  email?: string;
  address: string;
  city?: string;
  type: 'Individual' | 'Business' | 'Dealer';
  createdAt: string;
}

export interface Technician {
  id: string;
  name: string;
  phone: string;
  skills: string;
  active: boolean;
  branch?: string;
}

export interface Equipment {
  brand: string;
  category: ProductCategory;
  model: string;
  serialNo: string;
  capacity?: number;
  capacityUnit?: CapacityUnit;
  refrigerant?: Refrigerant;
  /** Nameplate refrigerant charge in grams, when known. Overrides estimates. */
  nameplateChargeG?: number;
  purchaseDate?: string;
  invoiceNo?: string;
  dealer?: string;
  warranty: WarrantyStatus;
  /** Last day of the general warranty, worked out from the invoice date. */
  warrantyUntil?: string;
  /** Last day of an extended compressor warranty, if any. */
  compressorWarrantyUntil?: string;
}

export interface Complaint {
  id: string;
  ticketNo: string;
  customerId: string;
  equipment: Equipment;
  complaintType: string;
  description: string;
  /** What the customer said when logging the complaint, in their own words. */
  customerStatement?: string;
  /** Person who called in (may differ from the account holder). */
  callerName?: string;
  callerPhone?: string;
  /** Customer's preferred visit date/time or availability window. */
  preferredVisit?: string;
  /** Helpdesk executive who logged the complaint. */
  loggedBy: string;
  loggedByEmail?: string;
  /** Who closed it (cleared if re-opened). */
  closedBy?: string;
  closedByEmail?: string;
  /** Branch handling the complaint. */
  branch?: string;
  priority: Priority;
  status: ComplaintStatus;
  technicianId?: string;
  source: 'Phone' | 'Walk-in' | 'Dealer' | 'Email' | 'WhatsApp' | 'Other';
  createdAt: string;
  updatedAt: string;
  /** SLA target resolution date/time (ISO). */
  dueAt: string;
  resolvedAt?: string;
  closedAt?: string;
  /** Helpdesk questionnaire answers and the causes suggested at the time. */
  diagnosis?: {
    answers: Record<string, string>;
    suggested: { causeId: string; likelihood: number }[];
  };
  /** Cause the technician confirmed at closure; feeds future suggestions. */
  confirmedCauseId?: string;
  // Job & closure details
  jobType?: JobType;
  /** Total interconnecting pipe length (m), used for extra refrigerant charge. */
  pipeLengthM?: number;
  /** Number of brazed joints made on the job. */
  brazedJoints?: number;
  /** Brazing method used on the job; gases of other methods are flagged. */
  brazingMethod?: BrazingMethod;
  /** Whether nitrogen was flowed through the pipe while brazing (prevents oxide scale). */
  nitrogenPurged?: boolean;
  /** Metres of circuit flushed (e.g. after compressor burn-out). */
  flushedPipeM?: number;
  /** Whether a nitrogen pressure / leak test was done. */
  pressureTested?: boolean;
  /** Refrigerant recovered from the system before opening it (g). */
  recoveredG?: number;
  rootCause?: string;
  resolution?: string;
  customerFeedback?: 1 | 2 | 3 | 4 | 5;
  serviceCharge?: number;
}

export type LogKind = 'status' | 'note' | 'assignment' | 'material' | 'alert' | 'customer';

export const CALL_OUTCOMES = [
  'Customer reached',
  'Not reachable',
  'Visit confirmed',
  'Reschedule requested',
  'Customer satisfied',
  'Customer not satisfied',
  'Escalated by customer',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface ComplaintLog {
  id: string;
  complaintId: string;
  at: string;
  kind: LogKind;
  text: string;
  by: string;
  byEmail?: string;
  /** For customer contact entries: the outcome of the call. */
  outcome?: CallOutcome;
}

export const BRAZING_METHODS = ['Oxy-Acetylene', 'LPG / Butane', 'MAPP'] as const;
export type BrazingMethod = (typeof BRAZING_METHODS)[number];

export type ItemType = 'Spare' | 'Refrigerant' | 'Brazing Gas' | 'Nitrogen' | 'Flushing Agent' | 'Consumable';

/** Item types whose usage is budgeted per job (gases and process consumables). */
export const GAS_TYPES: ItemType[] = ['Refrigerant', 'Brazing Gas', 'Nitrogen', 'Flushing Agent'];

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  type: ItemType;
  /** e.g. pcs, kg, m, cylinder, m³ */
  unit: string;
  /** For refrigerant items: which refrigerant this stock is. */
  refrigerant?: Refrigerant;
  /** Brands/models this spare fits (free text). */
  compatibility?: string;
  location?: string;
  stock: number;
  reorderLevel: number;
  unitCost: number;
  active: boolean;
  /**
   * Consumption norm for gases/consumables, in the item's unit. See
   * expectedConsumable() for how the terms combine.
   */
  norm?: ItemNorm;
  /** For brazing gases: the method this gas belongs to (unset = any method). */
  brazingMethod?: BrazingMethod;
}

export interface ItemNorm {
  /** Fixed allowance per job, added only when the item's activity took place. */
  perJob?: number;
  /** Per brazed joint (for nitrogen: purge while brazing, only when purging is recorded). */
  perJoint?: number;
  /** Per metre of circuit flushed. */
  perFlushM?: number;
  /** Per pressure test. */
  perPressureTest?: number;
  /** Additional per kW of system capacity, per pressure test. */
  perPressureTestKw?: number;
}

export type MovementKind = 'Receipt' | 'Issue' | 'Return' | 'Adjustment';

export interface StockMovement {
  id: string;
  itemId: string;
  kind: MovementKind;
  /** Signed quantity: + adds stock, - removes stock. */
  qty: number;
  at: string;
  complaintId?: string;
  technicianId?: string;
  reference?: string;
  note?: string;
  by: string;
  byEmail?: string;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface ConsumptionAlert {
  id: string;
  complaintId: string;
  technicianId?: string;
  itemId: string;
  code: string;
  at: string;
  severity: AlertSeverity;
  expected: number;
  actual: number;
  unit: string;
  message: string;
  acknowledged: boolean;
  ackNote?: string;
  /** Set when a later re-evaluation no longer raises this alert. */
  cleared?: boolean;
}

export interface Setting {
  id: string;
  value: unknown;
}

/** Local bookkeeping fields for syncing; never sent to the server. */
export interface SyncMeta {
  /** 1 = changed locally and not yet sent; 2 = rejected by the server. */
  _dirty?: 0 | 1 | 2;
  /** Server timestamp of the version held locally. */
  _serverAt?: string;
  /** Why the server rejected the last attempt to send this row. */
  _syncError?: string;
  /** Order in which the row was created on this device (upload order). */
  _seq?: number;
}
