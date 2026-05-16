/**
 * Tipos compartilhados entre specs E2E. Substituem os type-casts inline
 * duplicados (`as unknown as { id, status, ... }`) espalhados pelos
 * arquivos. Fixar o shape aqui pega regressao do back na compilacao.
 */

export interface BudgetDTO {
  id: string;
  status: 'Draft' | 'Sent' | 'Accepted' | 'Refused' | 'Expired' | 'Canceled';
  total: number;
  items?: Array<{ activityId: string; quantity: number }>;
  publicUrl?: string;
}

export interface EventDTO {
  id: string;
  kind: 'Commercial' | 'ScheduleBlock' | 'ExternalCommitment';
  clientId?: string;
  clientName?: string;
  budgetId?: string;
  status: 'Scheduled' | 'Confirmed' | 'InProgress' | 'Completed' | 'Canceled';
  total: number;
  teamSize: number;
  paymentPlanStatus: string | null;
  contractStatus: string | null;
  collaborators: EventCollaboratorDTO[];
  pricingItems?: Array<{ activityId?: string; quantity: number }>;
}

export interface EventCollaboratorDTO {
  collaboratorId: string;
  isLeader?: boolean;
  confirmationStatus: 'Invited' | 'Confirmed' | 'Declined';
  status?: string;
}

export interface LeadDTO {
  id: string;
  status: 'New' | 'InContact' | 'Qualified' | 'BudgetSent' | 'Converted' | 'Discarded' | 'Lost';
  clientId?: string;
  name: string;
}

export interface ClientDTO {
  id: string;
  name: string;
  email?: string;
  type: 'PF' | 'PJ';
}

/**
 * Regex que valida GUID/UUID v4 estilo do back (lowercase ou uppercase).
 * Substitui `expect(x).toBeTruthy()` em campos id.
 */
export const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
