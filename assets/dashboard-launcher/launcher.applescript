-- Only opens the installed Pilot Dashboard; never starts or stops the collector.
on run
    my launchDashboard()
end run

on reopen
    my launchDashboard()
end reopen

on launchDashboard()
    set isChinese to (user locale of (system info)) starts with "zh"
    set cancelLabel to "Cancel"
    set retryLabel to "Retry"
    set languageCode to "en"
    if isChinese then
        set cancelLabel to "取消"
        set retryLabel to "重试"
        set languageCode to "zh"
    end if
    repeat
        try
            -- This resource records the installed config path, not the port.
            set launcherPath to POSIX path of (path to resource "open-dashboard.sh")
            do shell script "LOONGSUITE_PILOT_LANG=" & languageCode & " /bin/bash " & quoted form of launcherPath
            return
        on error errorMessage number errorNumber
            activate
            try
                display dialog errorMessage with title "LoongSuite Pilot Dashboard" buttons {cancelLabel, retryLabel} default button retryLabel cancel button cancelLabel with icon caution
            on error number -128
                return
            end try
        end try
    end repeat
end launchDashboard
