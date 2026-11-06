// Install tabs (from @steamfield/ui) with copy tracking. An island so onCopy can call track().
import {
  InstallTabs,
  type InstallOption,
} from "@steamfield/ui/react/install-tabs";
import { track } from "../../lib/analytics";
import { Events } from "../../lib/events";

export function InstallPanel({
  options,
}: {
  options: readonly InstallOption[];
}) {
  return (
    <InstallTabs
      id="install"
      options={options}
      onCopy={(id, ok) => {
        if (ok) track(Events.installCopied, { method: id });
      }}
    />
  );
}
