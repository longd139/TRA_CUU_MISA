Set WshShell = CreateObject("WScript.Shell")
' Chay node server.js ngam hoan toan (khong hien cua so den CMD)
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "node server.js", 0, False
