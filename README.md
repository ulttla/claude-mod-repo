# claude-mod-repo

Small [mods](https://code.claude.com/docs/en/plugins/mods/overview) for Claude Code.

**[English](#english)** · **[한국어](#한국어)**

---

## English

A mod is a plugin that changes how Claude Code looks and behaves. This repository holds three, and works as a plugin marketplace, so you can install any of them by name.

| Mod | What it does | Where it works |
| :- | :- | :- |
| [`context-meter`](context-meter) | Shows the git branch, how full the context window is, how much the last turn added, and how much of your plan limits you have used, in a band above the prompt | Terminal and the Desktop app's Code tab |
| [`auto-pin`](auto-pin) | Pins a new session in the sidebar as soon as it starts | The Desktop app's Code tab |
| [`context-handoff`](context-handoff) | Once the context window is 40% full, has Claude write hand-off notes, resets the context, and continues from the notes | Terminal and the Desktop app's Code tab |

### Requirements

- **Terminal**: Claude Code v2.1.287 or later. Check with `claude --version`.
- **Desktop app**: a version that includes Claude Code v2.1.286 or later. In a local session in the Code tab, enter `/status` and read the **Claude Code** row.

### Install

A mod is code that runs with your permissions: it can read and write your files, start processes, and make network requests. Read the source before you install, or [list what each mod does](#check-what-a-mod-does-first).

Add this repository as a marketplace, then install the mods you want:

```bash
claude plugin marketplace add ulttla/claude-mod-repo
```

```bash
claude plugin install context-meter@claude-mod-repo
```

```bash
claude plugin install auto-pin@claude-mod-repo
```

```bash
claude plugin install context-handoff@claude-mod-repo
```

In a Claude Code session the same commands are `/plugin marketplace add ulttla/claude-mod-repo` and `/plugin install context-meter@claude-mod-repo`.

A mod loads the next time you start a session. In a session that is already open, run `/reload-plugins`.

### Try one without installing

Clone the repository and load a mod's folder for one terminal session:

```bash
git clone https://github.com/ulttla/claude-mod-repo.git
```

```bash
claude --plugin-dir ./claude-mod-repo/context-meter
```

### Check what a mod does first

With the repository cloned, this lists the events a mod handles and what it asks Claude Code to do, without running it:

```bash
claude plugin validate ./claude-mod-repo/context-meter
```

### context-meter

Draws one line above the prompt:

```text
main   Ctx 12% (119k/1M)   Last +119k   5H 1% ↻17:30   1W 25% ↻Wed 11:00
```

| Segment | Meaning |
| :- | :- |
| `main` | The current git branch. Left out when the session's folder is not in a git repository. On a detached HEAD, the short commit hash |
| `Ctx 12% (119k/1M)` | Context window: percent full, tokens used, window size |
| `Last +119k` | Tokens the last finished turn added. A negative number means the turn compacted the conversation |
| `5H 1% ↻17:30` | Five-hour plan limit: percent used, and when it resets |
| `1W 25% ↻Wed 11:00` | Weekly plan limit: percent used, and when it resets |

- A segment turns yellow at 70% and bold red at 90%.
- Reset times show only when the band is at least 100 columns wide.
- Plan limits show only on a subscription plan. On an API key the band shows the other segments alone.
- `/context-meter` prints the same line as text, for places that don't draw the band, such as the VS Code extension.

#### Options

Each segment can be turned on or off.

| Option | Default | What it shows |
| :- | :- | :- |
| `showBranch` | on | The current git branch |
| `showDirty` | off | A `*` after the branch name when the working tree has uncommitted changes, as in `main*`. Runs `git status` on each turn |
| `showModel` | off | The session's model |
| `showContext` | on | `Ctx`, the context window |
| `showLastTurn` | on | `Last`, what the last turn added |
| `showFiveHour` | on | `5H`, the five-hour plan limit |
| `showWeekly` | on | `1W`, the weekly plan limit |
| `showOtherLimits` | on | Any other limit your account reports, such as a gateway's spend limit (`Spend`) |
| `showResetTimes` | on | When each limit resets |
| `showCost` | off | What the session has cost in US dollars, as in `$1.24`. On a subscription plan this is an estimate at API prices, not a charge |

To change them in a terminal session, run `/plugin configure context-meter@claude-mod-repo`. From your shell, pass each one when you install:

```bash
claude plugin install context-meter@claude-mod-repo --config showModel=true --config showCost=true
```

A change takes effect in the next session, or after `/reload-plugins`.

### auto-pin

When you start a new session in the Desktop app's Code tab, the mod pins it in the sidebar. You unpin it yourself when the work is done.

- A session you reopen is left as it is, so one you unpinned stays unpinned.
- `/auto-pin` pins the current session on request, and says why when it can't.
- Outside the Desktop app there is no sidebar, and the mod does nothing.
- Sessions the app starts on its own, such as scheduled tasks, may be pinned too.

### context-handoff

A long session gets worse as its context fills up. This mod hands the work over to a fresh context before that happens, without you opening a new session.

After each turn it reads how full the context window is. Past the threshold (40% by default), it:

1. Submits a prompt that has Claude record a hand-off. When the project has a `session-close` skill, Claude is told to run it; otherwise Claude follows the session-close procedure in the project's `CLAUDE.md`, or updates `PROGRESS.md`, or writes `HANDOFF.md` at the project root.
2. When that turn ends, resets the context. By default it compacts the conversation down to where the notes are and the next step (the same as `/compact` with instructions), so the process, model and settings stay as they were. In the Desktop app the session has no compaction call of its own, so the mod runs `/compact` with those instructions instead, as if you had typed it. With `reset` set to `clear`, it instead asks the Desktop app to clear the conversation (the same as `/clear`): the session keeps its row in the sidebar, the old conversation stays under **Resume previous session**, but the app starts a new Claude Code process only at your next message.
3. Submits a prompt that has Claude read the notes and continue from the recorded next step.

Each step shows a toast. A message you had already queued runs first. If you interrupt the hand-off turn, or the reset fails, the mod gives up, says why, and tries again once the context has grown by another 5 points.

- `/handoff-now` hands off right away, at any context size. `/handoff-status` shows where the hand-off stands and what the mod did last.
- The prompts the mod submits are shown in the transcript, marked `[context-handoff]`, and each step leaves a dim `context-handoff:` line there.
- With the compaction through `/compact` (the Desktop app, or `compaction` set to `command`): the `/compact` line shows in the transcript, the resume follows once its compaction has run, and if nothing has been compacted within five minutes the mod gives up.
- With the clear: the app is asked as the hand-off turn starts and clears as it ends; if it has not within eight seconds, the mod gives up. If a message you queued runs after the hand-off turn, the notes are recorded again. The resume is written to the mod's store, so the process the app starts next continues from the notes. The app starts that process only when you send your next message, however long after the clear: that message runs first, then the resume. Until then the conversation stays empty. A session started from another device cannot be cleared, so Remote Control is turned off for the clear and on again after the resume (`pauseRemoteControl`). Outside the Desktop app there is no app to clear, so the mod gives up after recording the notes.

#### Options

| Option | Default | What it does |
| :- | :- | :- |
| `enabled` | on | Hand off on its own past the threshold. Off, only `/handoff-now` hands off |
| `threshold` | 40 | How full the context window is, in percent, before the hand-off starts |
| `retriggerStep` | 5 | After an interrupted or failed hand-off, try again once the context has grown this many points |
| `reset` | `compact` | How the context is reset: `compact` (in place, process and settings kept, no input needed) or `clear` (the Desktop app's clear: a fresh conversation, continued only after your next message) |
| `compaction` | `auto` | How the compaction is made: `auto` (the engine's compaction call, or `/compact` where the session has none, as in the Desktop app), `call` (the call alone) or `command` (`/compact` alone, queued as if typed) |
| `closeCommand` | `session-close` | The project skill Claude is told to run to record the hand-off, when the project has it |
| `closePrompt` | empty | Replaces the built-in hand-off prompt and the close skill. `{percent}` and `{threshold}` are filled in |
| `resumePrompt` | empty | Replaces the built-in prompt submitted after the reset |
| `pauseRemoteControl` | on | With the clear: turn Remote Control off for it, and on again after the resume. Off, such a session is not cleared |

To change them in a terminal session, run `/plugin configure context-handoff@claude-mod-repo`, or pass them when you install:

```bash
claude plugin install context-handoff@claude-mod-repo --config threshold=50
```

### Uninstall

```bash
claude plugin uninstall context-meter@claude-mod-repo
```

```bash
claude plugin uninstall auto-pin@claude-mod-repo
```

```bash
claude plugin uninstall context-handoff@claude-mod-repo
```

### License

[MIT](LICENSE). Shared as is, without support.

---

## 한국어

mod는 Claude Code의 모양과 동작을 바꾸는 플러그인입니다. 이 리포에는 mod 세 개가 들어 있고, 리포 자체가 플러그인 마켓플레이스 역할을 하므로 이름으로 골라 설치할 수 있습니다.

| Mod | 하는 일 | 동작하는 곳 |
| :- | :- | :- |
| [`context-meter`](context-meter) | git 브랜치, 컨텍스트 창이 얼마나 찼는지, 직전 턴이 얼마나 늘렸는지, 플랜 한도를 얼마나 썼는지를 입력창 위 한 줄로 표시 | 터미널, 데스크톱 앱 Code 탭 |
| [`auto-pin`](auto-pin) | 새 세션이 시작되면 사이드바에 바로 고정 | 데스크톱 앱 Code 탭 |
| [`context-handoff`](context-handoff) | 컨텍스트 창이 40% 차면 Claude가 인계 기록을 쓰게 하고, 컨텍스트를 초기화한 뒤, 기록을 읽어 이어감 | 터미널, 데스크톱 앱 Code 탭 |

### 요구 사항

- **터미널**: Claude Code v2.1.287 이상. `claude --version`으로 확인합니다.
- **데스크톱 앱**: Claude Code v2.1.286 이상이 포함된 버전. Code 탭의 로컬 세션에서 `/status`를 입력하고 **Claude Code** 행을 봅니다.

### 설치

mod는 사용자 권한으로 실행되는 코드입니다. 파일을 읽고 쓰고, 프로세스를 실행하고, 네트워크 요청을 보낼 수 있습니다. 설치하기 전에 소스를 읽거나 [mod가 하는 일을 먼저 확인](#mod가-하는-일-먼저-확인하기)하세요.

이 리포를 마켓플레이스로 추가한 뒤 원하는 mod를 설치합니다.

```bash
claude plugin marketplace add ulttla/claude-mod-repo
```

```bash
claude plugin install context-meter@claude-mod-repo
```

```bash
claude plugin install auto-pin@claude-mod-repo
```

```bash
claude plugin install context-handoff@claude-mod-repo
```

Claude Code 세션 안에서는 같은 명령을 `/plugin marketplace add ulttla/claude-mod-repo`, `/plugin install context-meter@claude-mod-repo`로 입력합니다.

mod는 다음에 세션을 시작할 때 로드됩니다. 이미 열려 있는 세션에서는 `/reload-plugins`를 실행합니다.

### 설치하지 않고 써 보기

리포를 클론한 뒤 터미널 세션 하나에만 mod 폴더를 로드합니다.

```bash
git clone https://github.com/ulttla/claude-mod-repo.git
```

```bash
claude --plugin-dir ./claude-mod-repo/context-meter
```

### mod가 하는 일 먼저 확인하기

리포를 클론한 상태에서 아래 명령을 실행하면, mod를 실행하지 않고 어떤 이벤트를 처리하고 Claude Code에 무엇을 요청하는지 나열합니다.

```bash
claude plugin validate ./claude-mod-repo/context-meter
```

### context-meter

입력창 위에 한 줄을 그립니다.

```text
main   Ctx 12% (119k/1M)   Last +119k   5H 1% ↻17:30   1W 25% ↻Wed 11:00
```

| 항목 | 의미 |
| :- | :- |
| `main` | 현재 git 브랜치. 세션 폴더가 git 리포가 아니면 생략됩니다. detached HEAD에서는 짧은 커밋 해시 |
| `Ctx 12% (119k/1M)` | 컨텍스트 창: 찬 비율, 사용한 토큰, 창 크기 |
| `Last +119k` | 직전에 끝난 턴이 늘린 토큰. 음수면 그 턴에서 대화가 압축된 것 |
| `5H 1% ↻17:30` | 5시간 플랜 한도: 사용률과 초기화 시각 |
| `1W 25% ↻Wed 11:00` | 주간 플랜 한도: 사용률과 초기화 시각 |

- 각 항목은 70%부터 노란색, 90%부터 굵은 빨간색으로 바뀝니다.
- 초기화 시각은 밴드 폭이 100칸 이상일 때만 표시됩니다.
- 플랜 한도는 구독 플랜에서만 표시됩니다. API 키로 쓰면 나머지 항목만 나옵니다.
- `/context-meter`는 같은 내용을 텍스트로 출력합니다. VS Code 확장처럼 밴드를 그리지 않는 곳에서 씁니다.

#### 옵션

항목마다 켜고 끌 수 있습니다.

| 옵션 | 기본값 | 표시 내용 |
| :- | :- | :- |
| `showBranch` | 켜짐 | 현재 git 브랜치 |
| `showDirty` | 꺼짐 | 커밋하지 않은 변경이 있으면 브랜치 이름 뒤에 `*` 표시 (예: `main*`). 턴마다 `git status`를 실행합니다 |
| `showModel` | 꺼짐 | 세션의 모델 |
| `showContext` | 켜짐 | `Ctx`, 컨텍스트 창 |
| `showLastTurn` | 켜짐 | `Last`, 직전 턴이 늘린 양 |
| `showFiveHour` | 켜짐 | `5H`, 5시간 플랜 한도 |
| `showWeekly` | 켜짐 | `1W`, 주간 플랜 한도 |
| `showOtherLimits` | 켜짐 | 계정이 보고하는 그 밖의 한도. 예: 게이트웨이의 지출 한도(`Spend`) |
| `showResetTimes` | 켜짐 | 각 한도의 초기화 시각 |
| `showCost` | 꺼짐 | 세션 비용(미국 달러, 예: `$1.24`). 구독 플랜에서는 실제 청구액이 아니라 API 가격 기준 추정치입니다 |

터미널 세션에서는 `/plugin configure context-meter@claude-mod-repo`로 바꿉니다. 셸에서는 설치할 때 하나씩 넘깁니다.

```bash
claude plugin install context-meter@claude-mod-repo --config showModel=true --config showCost=true
```

변경은 다음 세션부터, 또는 `/reload-plugins` 후에 적용됩니다.

### auto-pin

데스크톱 앱 Code 탭에서 새 세션을 시작하면 사이드바에 고정합니다. 작업이 끝나면 직접 고정을 해제하면 됩니다.

- 다시 연 세션은 건드리지 않으므로, 고정을 해제한 세션은 해제된 채로 남습니다.
- `/auto-pin`은 현재 세션을 직접 고정하고, 고정하지 못하면 이유를 알려 줍니다.
- 데스크톱 앱 밖에는 사이드바가 없으므로 아무 일도 하지 않습니다.
- 예약 작업처럼 앱이 스스로 시작하는 세션도 고정될 수 있습니다.

### context-handoff

긴 세션은 컨텍스트가 찰수록 품질이 떨어집니다. 이 mod는 그 전에 작업을 새 컨텍스트로 넘깁니다. 새 세션을 직접 열 필요가 없습니다.

턴이 끝날 때마다 컨텍스트 창이 얼마나 찼는지 읽고, 임계값(기본 40%)을 넘으면 다음을 차례로 합니다.

1. Claude가 인계 기록을 쓰도록 프롬프트를 제출합니다. 프로젝트에 `session-close` 스킬이 있으면 그 스킬을 실행하라고 지시하고, 없으면 프로젝트 `CLAUDE.md`의 세션 종료 절차를 따르거나, `PROGRESS.md`를 갱신하거나, 프로젝트 루트에 `HANDOFF.md`를 씁니다.
2. 그 턴이 끝나면 컨텍스트를 초기화합니다. 기본은 대화를 "기록 위치와 다음 단계"만 남기고 압축하는 것(`/compact`에 지시문을 붙인 것과 같음)이라 프로세스·모델·설정이 그대로 유지됩니다. 데스크톱 앱의 세션에는 압축 호출이 없으므로, 거기서는 직접 입력한 것처럼 같은 지시문으로 `/compact`를 실행합니다. `reset`을 `clear`로 두면 대신 데스크톱 앱에 대화를 비워 달라고 요청합니다(`/clear`와 같음). 세션은 사이드바의 같은 행에 남고 이전 대화는 **Resume previous session**으로 되돌릴 수 있지만, 앱은 다음 메시지를 보낼 때에야 새 Claude Code 프로세스를 띄웁니다.
3. Claude가 기록을 읽고 기록된 다음 시작점부터 이어가도록 프롬프트를 제출합니다.

단계마다 토스트로 알립니다. 이미 대기 중이던 메시지가 있으면 그것이 먼저 실행됩니다. 인계 턴을 중단하거나 초기화에 실패하면 포기하고 이유를 알린 뒤, 컨텍스트가 5포인트 더 차면 다시 시도합니다.

- `/handoff-now`는 컨텍스트 크기와 상관없이 바로 인계합니다. `/handoff-status`는 인계가 어느 단계인지와 마지막으로 한 일을 보여 줍니다.
- mod가 제출하는 프롬프트는 `[context-handoff]` 표시와 함께 대화에 보이고, 단계마다 흐릿한 `context-handoff:` 줄이 대화에 남습니다.
- `/compact`로 압축할 때(데스크톱 앱, 또는 `compaction`을 `command`로 둔 경우): `/compact` 줄이 대화에 보이고, 그 압축이 끝나면 재개합니다. 5분 안에 압축되지 않으면 포기합니다.
- `clear`일 때: 인계 턴이 시작될 때 앱에 요청하고 턴이 끝날 때 비워집니다. 8초 안에 비워지지 않으면 포기합니다. 대기 중이던 메시지가 인계 턴 뒤에 실행되면 기록을 다시 씁니다. 재개 지시는 mod 저장소에 적어 두므로 앱이 다음에 띄우는 프로세스가 기록을 읽고 이어갑니다. 앱은 비운 뒤 아무리 시간이 지나도 다음 메시지를 보낼 때에야 그 프로세스를 띄우며, 그 메시지가 먼저 실행된 뒤 재개합니다. 그때까지 대화는 비어 있습니다. 다른 기기에서 시작한 세션은 비울 수 없으므로 비우는 동안 Remote Control을 끄고 재개 후 다시 켭니다(`pauseRemoteControl`). 데스크톱 앱 밖에는 비워 줄 앱이 없으므로 기록만 쓴 뒤 포기합니다.

#### 옵션

| 옵션 | 기본값 | 하는 일 |
| :- | :- | :- |
| `enabled` | 켜짐 | 임계값을 넘으면 자동으로 인계. 끄면 `/handoff-now`로만 인계 |
| `threshold` | 40 | 인계를 시작하는 컨텍스트 창 사용률(%) |
| `retriggerStep` | 5 | 중단되거나 실패한 인계를 컨텍스트가 몇 포인트 더 찼을 때 다시 시도할지 |
| `reset` | `compact` | 컨텍스트 초기화 방식: `compact`(제자리 압축, 프로세스·설정 유지, 입력 불필요) 또는 `clear`(데스크톱 앱의 비우기: 새 대화, 다음 메시지를 보내야 이어감) |
| `compaction` | `auto` | 압축 방법: `auto`(엔진의 압축 호출, 데스크톱 앱처럼 호출이 없는 세션에서는 `/compact`), `call`(호출만), `command`(`/compact`만, 입력한 것처럼 큐에 넣음) |
| `closeCommand` | `session-close` | 프로젝트에 있을 때 인계 기록용으로 실행하라고 지시할 스킬 |
| `closePrompt` | 비어 있음 | 내장 인계 프롬프트와 스킬 지시를 대체. `{percent}`, `{threshold}`가 채워짐 |
| `resumePrompt` | 비어 있음 | 초기화 뒤 제출하는 내장 프롬프트를 대체 |
| `pauseRemoteControl` | 켜짐 | `clear`일 때 비우는 동안 Remote Control을 끄고 재개 후 다시 켬. 끄면 그런 세션은 비우지 않음 |

터미널 세션에서는 `/plugin configure context-handoff@claude-mod-repo`로 바꾸거나, 설치할 때 넘깁니다.

```bash
claude plugin install context-handoff@claude-mod-repo --config threshold=50
```

### 제거

```bash
claude plugin uninstall context-meter@claude-mod-repo
```

```bash
claude plugin uninstall auto-pin@claude-mod-repo
```

```bash
claude plugin uninstall context-handoff@claude-mod-repo
```

### 라이선스

[MIT](LICENSE). 지원 없이 있는 그대로 공유합니다.
