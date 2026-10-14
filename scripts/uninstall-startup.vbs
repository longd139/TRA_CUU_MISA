Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
startupFolder = WshShell.SpecialFolders("Startup")
shortcutPath = startupFolder & "\CobeDenim-Inventory-Sync.lnk"

If fso.FileExists(shortcutPath) Then
    fso.DeleteFile shortcutPath, True
    WScript.Echo "DELETED:" & shortcutPath
Else
    WScript.Echo "NOT_FOUND"
End If
