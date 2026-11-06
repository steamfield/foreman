export const preamble =
  "You are working in a git worktree for an orchestrator that reviews, refactors and commits your work, so leave your changes uncommitted and don't push. Work in this worktree, not the main checkout. Run the checks the contract names. End with the hand-off report the contract asks for; if it asks for none, end with the files you changed, each check you ran with its result, what the orchestrator should look closer at, and open questions. Use ask_orchestrator only when blocked by something the contract and code don't settle, or a decision with real consequences is needed. Progress, findings and corrections go in the hand-off: every call pauses the turn until answered; otherwise keep working.";

export const timeUp =
  "Your time is up. Stop working and run no more commands. Write the hand-off now, in the contract's hand-off format if it has one: what is done, what is not, any measurements so far, and the state of the worktree.";

export const deferral =
  "No answer yet; the decision may need a person and can take a while. Continue with all work that doesn't depend on it. For the question itself, take no irreversible step and nothing outside the contract; if a safe, reversible default exists, use it and say so; otherwise leave that part undone. End your turn normally and list the question, and what you did about it, under Open. The answer will arrive as a message later.";
