# claude-mode-repo

Small [mods](https://code.claude.com/docs/en/plugins/mods/overview) for Claude Code.

**[English](#english)** · **[한국어](#한국어)**

---

## English

A mod is a plugin that changes how Claude Code looks and behaves. This repository holds two, and works as a plugin marketplace, so you can install either one by name.

| Mod | What it does | Where it works |
| :- | :- | :- |
| [`context-meter`](context-meter) | Shows how full the context window is, how much the last turn added, and how much of your plan limits you have used, in a band above the prompt | Terminal and the Desktop app's Code tab |
| [`auto-pin`](auto-pin) | Pins a new session in the sidebar as soon as it starts | The Desktop app's Code tab |

### Requirements

- **Terminal**: Claude Code v2.1.287 or later. Check with `claude --version`.
- **Desktop app**: a version that includes Claude Code v2.1.286 or later. In a local session in the Code tab, enter `/status` and read the **Claude Code** row.

### Install

A mod is code that runs with your permissions: it can read and write your files, start processes, and make network requests. Read the source before you install, or [list what each mod does](#check-what-a-mod-does-first).

Add this repository as a marketplace, then install the mods you want:

```bash
claude plugin marketplace add ulttla/claude-mode-repo
```

```bash
claude plugin install context-meter@claude-mode-repo
```

```bash
claude plugin install auto-pin@claude-mode-repo
```

In a Claude Code session the same commands are `/plugin marketplace add ulttla/claude-mode-repo` and `/plugin install context-meter@claude-mode-repo`.

A mod loads the next time you start a session. In a session that is already open, run `/reload-plugins`.

### Try one without installing

Clone the repository and load a mod's folder for one terminal session:

```bash
git clone https://github.com/ulttla/claude-mode-repo.git
```

```bash
claude --plugin-dir ./claude-mode-repo/context-meter
```

### Check what a mod does first

With the repository cloned, this lists the events a mod handles and what it asks Claude Code to do, without running it:

```bash
claude plugin validate ./claude-mode-repo/context-meter
```

### context-meter

Draws one line above the prompt:

```text
컨텍스트 12% (119k/1M)   직전 턴 +119k   5시간 1% ↻17:30   주간 25% ↻11:00
```

| Segment | Meaning |
| :- | :- |
| `컨텍스트 12% (119k/1M)` | Context window: percent full, tokens used, window size |
| `직전 턴 +119k` | Tokens the last finished turn added. A negative number means the turn compacted the conversation |
| `5시간 1% ↻17:30` | Five-hour plan limit: percent used, and when it resets |
| `주간 25% ↻11:00` | Weekly plan limit: percent used, and when it resets |

- A segment turns yellow at 70% and bold red at 90%.
- Reset times show only when the band is at least 100 columns wide.
- Plan limits show only on a subscription plan. On an API key the band shows the context segments alone.
- `/context-meter` prints the same line as text, for places that don't draw the band, such as the VS Code extension.
- The labels are in Korean. To change them, edit the strings in [`context-meter/hooks/register.js`](context-meter/hooks/register.js).

### auto-pin

When you start a new session in the Desktop app's Code tab, the mod pins it in the sidebar. You unpin it yourself when the work is done.

- A session you reopen is left as it is, so one you unpinned stays unpinned.
- `/auto-pin` pins the current session on request, and says why when it can't.
- Outside the Desktop app there is no sidebar, and the mod does nothing.
- Sessions the app starts on its own, such as scheduled tasks, may be pinned too.

### Uninstall

```bash
claude plugin uninstall context-meter@claude-mode-repo
```

```bash
claude plugin uninstall auto-pin@claude-mode-repo
```

### License

[MIT](LICENSE). Shared as is, without support.

---

## 한국어

mod는 Claude Code의 모양과 동작을 바꾸는 플러그인입니다. 이 리포에는 mod 두 개가 들어 있고, 리포 자체가 플러그인 마켓플레이스 역할을 하므로 이름으로 골라 설치할 수 있습니다.

| Mod | 하는 일 | 동작하는 곳 |
| :- | :- | :- |
| [`context-meter`](context-meter) | 컨텍스트 창이 얼마나 찼는지, 직전 턴이 얼마나 늘렸는지, 플랜 한도를 얼마나 썼는지를 입력창 위 한 줄로 표시 | 터미널, 데스크톱 앱 Code 탭 |
| [`auto-pin`](auto-pin) | 새 세션이 시작되면 사이드바에 바로 고정 | 데스크톱 앱 Code 탭 |

### 요구 사항

- **터미널**: Claude Code v2.1.287 이상. `claude --version`으로 확인합니다.
- **데스크톱 앱**: Claude Code v2.1.286 이상이 포함된 버전. Code 탭의 로컬 세션에서 `/status`를 입력하고 **Claude Code** 행을 봅니다.

### 설치

mod는 사용자 권한으로 실행되는 코드입니다. 파일을 읽고 쓰고, 프로세스를 실행하고, 네트워크 요청을 보낼 수 있습니다. 설치하기 전에 소스를 읽거나 [mod가 하는 일을 먼저 확인](#mod가-하는-일-먼저-확인하기)하세요.

이 리포를 마켓플레이스로 추가한 뒤 원하는 mod를 설치합니다.

```bash
claude plugin marketplace add ulttla/claude-mode-repo
```

```bash
claude plugin install context-meter@claude-mode-repo
```

```bash
claude plugin install auto-pin@claude-mode-repo
```

Claude Code 세션 안에서는 같은 명령을 `/plugin marketplace add ulttla/claude-mode-repo`, `/plugin install context-meter@claude-mode-repo`로 입력합니다.

mod는 다음에 세션을 시작할 때 로드됩니다. 이미 열려 있는 세션에서는 `/reload-plugins`를 실행합니다.

### 설치하지 않고 써 보기

리포를 클론한 뒤 터미널 세션 하나에만 mod 폴더를 로드합니다.

```bash
git clone https://github.com/ulttla/claude-mode-repo.git
```

```bash
claude --plugin-dir ./claude-mode-repo/context-meter
```

### mod가 하는 일 먼저 확인하기

리포를 클론한 상태에서 아래 명령을 실행하면, mod를 실행하지 않고 어떤 이벤트를 처리하고 Claude Code에 무엇을 요청하는지 나열합니다.

```bash
claude plugin validate ./claude-mode-repo/context-meter
```

### context-meter

입력창 위에 한 줄을 그립니다.

```text
컨텍스트 12% (119k/1M)   직전 턴 +119k   5시간 1% ↻17:30   주간 25% ↻11:00
```

| 항목 | 의미 |
| :- | :- |
| `컨텍스트 12% (119k/1M)` | 컨텍스트 창: 찬 비율, 사용한 토큰, 창 크기 |
| `직전 턴 +119k` | 직전에 끝난 턴이 늘린 토큰. 음수면 그 턴에서 대화가 압축된 것 |
| `5시간 1% ↻17:30` | 5시간 플랜 한도: 사용률과 초기화 시각 |
| `주간 25% ↻11:00` | 주간 플랜 한도: 사용률과 초기화 시각 |

- 각 항목은 70%부터 노란색, 90%부터 굵은 빨간색으로 바뀝니다.
- 초기화 시각은 밴드 폭이 100칸 이상일 때만 표시됩니다.
- 플랜 한도는 구독 플랜에서만 표시됩니다. API 키로 쓰면 컨텍스트 항목만 나옵니다.
- `/context-meter`는 같은 내용을 텍스트로 출력합니다. VS Code 확장처럼 밴드를 그리지 않는 곳에서 씁니다.
- 라벨은 한국어입니다. 바꾸려면 [`context-meter/hooks/register.js`](context-meter/hooks/register.js)의 문자열을 수정하세요.

### auto-pin

데스크톱 앱 Code 탭에서 새 세션을 시작하면 사이드바에 고정합니다. 작업이 끝나면 직접 고정을 해제하면 됩니다.

- 다시 연 세션은 건드리지 않으므로, 고정을 해제한 세션은 해제된 채로 남습니다.
- `/auto-pin`은 현재 세션을 직접 고정하고, 고정하지 못하면 이유를 알려 줍니다.
- 데스크톱 앱 밖에는 사이드바가 없으므로 아무 일도 하지 않습니다.
- 예약 작업처럼 앱이 스스로 시작하는 세션도 고정될 수 있습니다.

### 제거

```bash
claude plugin uninstall context-meter@claude-mode-repo
```

```bash
claude plugin uninstall auto-pin@claude-mode-repo
```

### 라이선스

[MIT](LICENSE). 지원 없이 있는 그대로 공유합니다.
