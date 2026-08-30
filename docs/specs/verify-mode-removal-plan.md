# Implementation Plan: Remove Verify Mode

> Date: 2026-08-30
> Branch: `feature/visual-verification-loop`

## Goal

Remove the verify mode toggle and make baseline + auth capture automatic at annotation time.

## Current State

- **OverlayApp.tsx**: Has verify mode checkbox at line 954, `verifyMode` state at line 482
- **verify-mode.ts**: Contains verify mode state, navigation lock, visual indicator (226 lines)
- **Spec**: References verify mode as opt-in feature in §3, §8

## Required Changes

### 1. OverlayApp.tsx

**Remove:**

- `const [verifyMode, setVerifyMode] = React.useState(false);` (line 482)
- Verify mode checkbox UI (lines 949-960)
- Import of `activateVerifyMode` (line 11)

**Keep/Modify:**

- Baseline capture logic (already automatic - good)
- Auth capture logic (needs import of `captureAndStoreAuthState`)

**Import changes:**

```typescript
// Remove:
import { activateVerifyMode } from "../overlay-browser/core/verify-mode.js";

// Add:
import { sendBaselineToServer, captureAndStoreAuthState } from "../overlay-browser/core/verify-mode.js";
```

### 2. verify-mode.ts

**Remove entirely:**

- `VerifyModeState` interface
- `verifyState` object
- `isVerifyModeActive()` function
- `getVerifyModeTaskId()` function
- `installNavigationLock()` function
- `uninstallNavigationLock()` function
- `createIndicator()` function
- `showIndicator()` function
- `removeIndicator()` function
- `activateVerifyMode()` function
- `deactivateVerifyMode()` function

**Keep (export):**

- `sendBaselineToServer()` function
- `captureAndStoreAuthState()` function

**Rename file:** `verify-mode.ts` → `capture.ts` (optional, but cleaner)

### 3. Spec Updates

**§3 Architecture Overview:**

- Remove lines about "User toggles verify mode ON"
- Remove navigation lock, visual indicator references

**§8 Verify Mode:**

- Remove entirely or replace with "Baseline + auth capture happen automatically at annotation time"

**§8.1-8.4:**

- Remove all subsections

### 4. Test Updates

**Files to check:**

- `tests/unit/baseline.test.ts` - May reference verify mode
- `tests/unit/auth.test.ts` - May reference verify mode
- `tests/unit/overlay.test.ts` - May reference verify mode

**Changes needed:**

- Remove any verify mode references
- Ensure tests verify automatic capture behavior

## Implementation Order

1. Create `capture.ts` with only the two needed functions
2. Update OverlayApp.tsx imports and remove verify mode UI
3. Update spec
4. Update tests
5. Remove old verify-mode.ts
6. Run build + tests

## Risks

1. **Import path changes** - Other files may import from verify-mode.ts
   - Mitigation: Check for all imports, update or create re-export

2. **Bundle size** - Removing code should reduce bundle size
   - Mitigation: Verify build output

3. **Test failures** - Tests may depend on verify mode
   - Mitigation: Update tests before removing code

## Success Criteria

- [ ] Verify mode checkbox removed from UI
- [ ] Baseline capture automatic at annotation time
- [ ] Auth capture automatic at annotation time
- [ ] No navigation lock
- [ ] No visual indicator
- [ ] All tests pass
- [ ] Build succeeds
