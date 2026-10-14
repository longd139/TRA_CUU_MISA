Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
vbsTarget = scriptDir & "\run-background.vbs"
startupFolder = WshShell.SpecialFolders("Startup")
shortcutPath = startupFolder & "\CobeDenim-Inventory-Sync.lnk"

Set shortcut = WshShell.CreateShortcut(shortcutPath)
shortcut.TargetPath = "wscript.exe"
shortcut.Arguments = """" & vbsTarget & """"
shortcut.WorkingDirectory = scriptDir
shortcut.WindowStyle = 7
shortcut.Description = "Cobe Denim MShopKeeper Inventory Auto Sync"
shortcut.Save

WScript.Echo "OK:" & shortcutPath
