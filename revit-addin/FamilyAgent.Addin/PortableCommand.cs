using System;
using System.IO;
using System.Linq;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace FamilyAgent.Addin
{
    /// <summary>
    /// Command chạy độc lập không cần cài đặt cố định vào Revit.
    /// Nhận diện file spec.json tại thư mục chứa Addin và tự động dựng Family rồi thoát.
    /// </summary>
    [Transaction(TransactionMode.Manual)]
    [Regeneration(RegenerationOption.Manual)]
    public sealed class PortableBuildCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            var app = commandData.Application.Application;
            var addinDir = Path.GetDirectoryName(typeof(PortableBuildCommand).Assembly.Location) ?? AppDomain.CurrentDomain.BaseDirectory;

            // Tìm file spec.json trong cùng thư mục
            var specFile = Directory.GetFiles(addinDir, "*spec*.json")
                .Concat(Directory.GetFiles(addinDir, "*.json"))
                .FirstOrDefault();

            if (specFile == null || !File.Exists(specFile))
            {
                var errorLog = Path.Combine(addinDir, "build_error.log");
                File.WriteAllText(errorLog, "Không tìm thấy file spec.json trong thư mục: " + addinDir);
                return Result.Failed;
            }

            try
            {
                var json = File.ReadAllText(specFile);
                var result = FamilyBuilder.Build(app, json);

                var logPath = Path.Combine(addinDir, "build_result.txt");
                if (result.Ok)
                {
                    // Copy file .rfa kết quả về ngay thư mục Portable để người dùng dễ lấy
                    var destination = Path.Combine(addinDir, Path.GetFileName(result.Path));
                    if (File.Exists(result.Path))
                    {
                        File.Copy(result.Path, destination, true);
                    }

                    File.WriteAllText(
                        logPath,
                        $"SUCCESS\nPath: {destination}\nRevitVersion: {result.RevitVersion}" +
                        (result.Warnings.Count > 0
                            ? "\nWarnings:\n" + string.Join("\n", result.Warnings)
                            : ""));
                }
                else
                {
                    File.WriteAllText(logPath, $"FAILED\nError: {result.Error}\nWarnings:\n" + string.Join("\n", result.Warnings));
                }

                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                var logPath = Path.Combine(addinDir, "build_crash.log");
                File.WriteAllText(logPath, ex.ToString());
                return Result.Failed;
            }
        }
    }
}

