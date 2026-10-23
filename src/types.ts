export type Page = "home" | "browse" | "library" | "games" | "settings";
export type Theme = "system" | "light" | "dark" | "oled";
export type Accent = "red" | "orange" | "yellow" | "lime" | "green" | "cyan" | "blue" | "indigo" | "purple" | "pink";
export type Lang = "system" | "ru" | "en";
export type ToastFn = (text: string, kind?: "ok" | "err" | "info") => void;

export type GameSettings = {
  fullscreen: boolean;
  width: number;
  height: number;
  hideLauncher: boolean;
  quitOnExit: boolean;
  journalOnLaunch: boolean;
  journalOnCrash: boolean;
  journalHideOnExit: boolean;
  showPlaytime: boolean;
  recordPlaytime: boolean;
  alwaysHours: boolean;
  minMem: number;
  maxMem: number;
  jvmArgs: string;
  javaPath: string;
};
export type InstanceSettings = Partial<GameSettings> & { override?: boolean };
export type Settings = {
  theme: Theme;
  accent: Accent;
  glow: boolean;
  motion: boolean;
  lang: Lang;
  clientId: string;
  game: GameSettings;
};

export type Instance = {
  id: string;
  name: string;
  mcVersion: string;
  loader: string;
  loaderVersion: string;
  icon?: string | null;
  profile?: string | null;
  played: number;
  lastPlayed: number;
  settings?: InstanceSettings | null;
  sourceProject?: string | null;
  sourceVersion?: string | null;
  packDetached?: boolean;
};
export type DeviceCode = { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number };
export type PackUpdate = { versionId: string; versionName: string };
export type VersionEntry = { id: string; type: string; url: string };
export type Account = { id: string; name: string; kind: "ms" | "ely" | "offline" };
export type AccountsInfo = { accounts: Account[]; active: string | null };
export type Hit = {
  project_id: string;
  slug?: string;
  title: string;
  description: string;
  icon_url?: string | null;
  featured_gallery?: string | null;
  gallery?: string[] | null;
  downloads: number;
  author: string;
  categories: string[];
};
export type MrVersion = {
  id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  version_type: string;
};
export type Progress = { done: number; total: number };
export type FsEntry = { name: string; isDir: boolean; size: number; modified: number };
