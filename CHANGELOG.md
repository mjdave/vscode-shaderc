# Change Log
Version 0.2.0

## 24 Nov 2018

Version 0.2.0
- Now parses all glsl files in your workspace to keep a list of #includes, so when you build an included file it will also re-build all includers.
- Build All now builds all glsl files in your workspace, not just those that are open.

## 23 Nov 2018

Version 0.1.0
- Adresses issue where modifications to included files are not compiled in parent files by:
    - Adding 'build' and 'build all' commands with menu items
    - By default, saving no longer exports spv files
    
Version 0.1.1
- Fix issue where glsl files would be rebuilt if 'buildAllOnSave' option was set even if a non glsl file in the workspace was saved
    

## 16 Nov 2018

Version 0.0.3
- Fixes bug where errors in included files would show up at the line number of the parent file. These errors now show up at the #include line.

Version 0.0.2
- Adds option to disable .spv output
- Fixes bug where output would go to /filename.spv if the output path was set to an empty string

## 15 Nov 2018
Version 0.0.1
- Initial release