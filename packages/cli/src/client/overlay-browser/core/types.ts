// Type declarations for the browser overlay.

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  selector: string;
  cssSelector?: string;
  url?: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  type?: string;
  priority?: string;
  created: string;
  updated?: string;
}

export interface TaskGroup {
  [selector: string]: Task[];
}

export interface ProtoConfig {
  port: number;
  wsUrl: string;
  apiUrl: string;
  pagesUrl: string;
  boardId?: string;
  overlayApiKey?: string;
}
