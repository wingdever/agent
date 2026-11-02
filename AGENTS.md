1. when update database schema just rm db file instead of update.
2. not edit files data-struct.md and ui.md except let you do so.
3. use english for code especially hardcode name and description.
4. before implementing, grill the need/situation first and only build after the user checks ok.
5. this is a development project, not a live application: user history data does not matter. do not add migration or backward-compatibility code for old sessions; deleting old sessions or the database is acceptable. old sessions do not need new system-prompt policies.
