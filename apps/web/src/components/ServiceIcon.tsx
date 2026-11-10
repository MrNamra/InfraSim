import {
  Activity,
  Archive,
  BarChart3,
  Bot,
  Box,
  Clock,
  Compass,
  Cpu,
  Database,
  DoorOpen,
  Eye,
  FileJson,
  FileText,
  Folder,
  GitFork,
  GitMerge,
  Globe,
  HardDrive,
  KeyRound,
  Languages,
  Laptop,
  Layers,
  ListOrdered,
  Lock,
  Mail,
  MessageSquareCode,
  Network,
  Radio,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties,
  TrendingUp,
  Users,
  Volume2,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Provider } from '@infrasim/shared-types';

const ICON_MAP: Record<string, LucideIcon> = {
  compute: Cpu,
  fn: Zap,
  lb: GitFork,
  gw: DoorOpen,
  cdn: Globe,
  dns: Compass,
  net: Network,
  object: Archive,
  block: HardDrive,
  file: Folder,
  sql: Database,
  kv: TableProperties,
  doc: FileJson,
  cache: Layers,
  graph: Share2,
  ts: TrendingUp,
  olap: BarChart3,
  search: Search,
  queue: ListOrdered,
  topic: Radio,
  stream: Activity,
  bus: GitMerge,
  workflow: Workflow,
  auth: ShieldCheck,
  secret: KeyRound,
  kms: Lock,
  email: Mail,
  async: Clock,
  llm: MessageSquareCode,
  ml: SlidersHorizontal,
  vision: Eye,
  speech: Volume2,
  'text-ai': Languages,
  'doc-ai': FileText,
  bot: Bot,
  client: Laptop,
  internet: Globe,
  users: Users,
  generic: Box,
};

export interface ServiceIconProps {
  icon: string;
  className?: string;
}

/** Renders the consistent 16px 1.5-stroke line icon for a catalog kind or generic block. */
export function ServiceIcon({ icon, className = 'h-4 w-4 shrink-0' }: ServiceIconProps) {
  const Icon = ICON_MAP[icon] ?? Box;
  return <Icon className={className} strokeWidth={1.5} aria-hidden="true" />;
}

export const PROVIDER_META: Record<
  Provider,
  { label: string; short: string; stripeColor: string }
> = {
  aws: { label: 'AWS', short: 'AWS', stripeColor: '#d97706' },
  gcp: { label: 'GCP', short: 'GCP', stripeColor: '#3b82f6' },
  azure: { label: 'Azure', short: 'AZR', stripeColor: '#0284c7' },
  oci: { label: 'OCI', short: 'OCI', stripeColor: '#dc2626' },
  generic: { label: 'Generic', short: 'GEN', stripeColor: '#71717a' },
  custom: { label: 'Custom', short: 'CST', stripeColor: '#8b5cf6' },
};
