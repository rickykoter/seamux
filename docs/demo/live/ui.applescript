-- ui — drive the demo app through its accessibility tree, without focus.
--
--   osascript ui.applescript PID dump              every control: role | title | description | value | x,y
--   osascript ui.applescript PID press TEXT        AXPress the first control whose title or description starts with TEXT
--   osascript ui.applescript PID pressx TEXT       the same, for a title or description that is exactly TEXT
--   osascript ui.applescript PID set TEXT VALUE    set the value of the first text field whose description or title starts with TEXT
--   osascript ui.applescript PID frame X Y W H     move and size the window
on run argv
	set pid to (item 1 of argv) as integer
	set verb to item 2 of argv
	tell application "System Events"
		tell (first process whose unix id is pid)
			if verb is "frame" then
				set position of (first window whose name is "seamux") to {(item 3 of argv) as integer, (item 4 of argv) as integer}
				set size of (first window whose name is "seamux") to {(item 5 of argv) as integer, (item 6 of argv) as integer}
				return "ok"
			end if
			set els to entire contents of (first window whose name is "seamux")
			set out to ""
			repeat with e in els
				try
					set r to role of e
					set t to ""
					try
						set t to title of e as text
					end try
					if t is "missing value" then set t to ""
					set d to ""
					try
						set d to description of e as text
					end try
					if d is "missing value" then set d to ""
					if verb is "dump" then
						if r is in {"AXButton", "AXLink", "AXTextField", "AXTextArea", "AXPopUpButton", "AXRadioButton", "AXCheckBox", "AXMenuButton", "AXComboBox"} then
							set v to ""
							try
								set v to value of e as text
							end try
							set p to position of e
							set out to out & r & " | " & t & " | " & d & " | " & v & " | " & (item 1 of p) & "," & (item 2 of p) & linefeed
						end if
					else if verb is "press" or verb is "pressx" then
						set want to item 3 of argv
						if verb is "pressx" then
							set hit to (t is want or d is want)
						else
							set hit to (t starts with want or d starts with want)
						end if
						if r is in {"AXButton", "AXLink", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXMenuButton"} and hit then
							perform action "AXPress" of e
							return "pressed " & r & " " & t & d
						end if
					else if verb is "set" then
						set want to item 3 of argv
						if r is in {"AXTextField", "AXTextArea", "AXComboBox"} and (t starts with want or d starts with want) then
							set focused of e to true
							set value of e to (item 4 of argv)
							return "set " & t & d
						end if
					end if
				end try
			end repeat
			if verb is "dump" then return out
			return "none: " & (item 3 of argv)
		end tell
	end tell
end run
