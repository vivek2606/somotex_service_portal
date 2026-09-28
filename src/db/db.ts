import Dexie, { type EntityTable } from 'dexie';
import type {
  Complaint,
  ComplaintLog,
  ConsumptionAlert,
  Customer,
  InventoryItem,
  Setting,
  StockMovement,
  Technician,
} from './types';

export class ServiceDB extends Dexie {
  customers!: EntityTable<Customer, 'id'>;
  technicians!: EntityTable<Technician, 'id'>;
  complaints!: EntityTable<Complaint, 'id'>;
  logs!: EntityTable<ComplaintLog, 'id'>;
  items!: EntityTable<InventoryItem, 'id'>;
  movements!: EntityTable<StockMovement, 'id'>;
  alerts!: EntityTable<ConsumptionAlert, 'id'>;
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'somotex-service-portal') {
    super(name);
    this.version(1).stores({
      customers: '++id, name, phone, city, createdAt',
      technicians: '++id, name, active',
      complaints:
        '++id, &ticketNo, customerId, status, priority, technicianId, createdAt, closedAt, dueAt, equipment.brand, equipment.category, equipment.serialNo',
      logs: '++id, complaintId, at',
      items: '++id, &sku, name, type, refrigerant',
      movements: '++id, itemId, kind, at, complaintId, technicianId',
      alerts: '++id, complaintId, technicianId, itemId, at, severity, acknowledged',
      settings: '&key',
    });
  }
}

export const db = new ServiceDB();
