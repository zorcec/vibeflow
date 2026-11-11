import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names into a single string, resolving Tailwind conflicts
 * so the later class wins (`cn("px-2", "px-4")` → `"px-4"`).
 * Falsy and conditional inputs follow `clsx` semantics.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
